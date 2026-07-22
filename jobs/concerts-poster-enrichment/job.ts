/**
 * Nightly cron: enrich concert rows missing a poster image
 * (`concerts.image_url IS NULL`) with the resolved headliner's Discogs
 * artist image, via LML's `getArtistDetails` (BS#1743).
 *
 * Chained after the concert artist resolvers (05:15 UTC strict/alias, 05:35
 * UTC LML) and the genre/similar-artists enrichment siblings so it only ever
 * sees headliners those passes have resolved. For each candidate concert it
 * dedupes by headliner Discogs id, calls `GET /api/v1/discogs/artist/:id`
 * once per distinct artist, and — when the artist has a usable image — writes
 * it onto every concert row that artist headlines. Default schedule
 * `05 6 * * *` UTC.
 *
 * DEPENDS ON WXYC/Backend-Service#1742 (preserve-on-null COALESCE in the
 * `triangle-shows-etl` / `venue-events-scraper` writers) being deployed
 * FIRST — without it, the next scrape cycle's image-less pass clobbers the
 * poster this job writes. See `writer.ts` and the README for detail.
 *
 * Modes:
 *   - default (nightly): upcoming-only candidate window (venue-local Eastern
 *     date), so the LML budget is never spent on past shows the feed won't
 *     serve.
 *   - `--backfill`: drop the window and front-fill every existing resolved,
 *     unenriched headliner — the one-time deploy backfill. Idempotent: the
 *     `image_url IS NULL` candidate predicate + write guard make a re-run a
 *     no-op over already-enriched (or already-scraped-with-a-poster) rows.
 *   - `--dry-run`: enumerate + log the plan; no LML calls, no writes.
 *
 * Enrichment runs nightly server-to-server with the LML API key (merged at
 * the `@wxyc/lml-client` chokepoint from `LML_API_KEY`); it is never on any
 * listener hot path.
 *
 * Run procedure: see jobs/concerts-poster-enrichment/README.md.
 */

import { sql } from 'drizzle-orm';
import { closeDatabaseConnection, db, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { getArtistDetails } from '@wxyc/lml-client';
import { defaultLmlLimiter } from './lml-limiter.js';
import { loadEnrichmentCandidates } from './query.js';
import { runEnrichment, type Totals } from './orchestrate.js';
import { writeConcertImages } from './writer.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'concerts-poster-enrichment';

// -- Env knobs ---------------------------------------------------------------

/** Distinct headliners per page (paces the cooperative-pause probe + log cadence). */
export const PAGE_SIZE_ENV = 'CONCERTS_POSTER_ENRICH_PAGE_SIZE';
export const PAGE_SIZE_DEFAULT = 10;

/** Cooperative-pause lookback window (seconds). `0` disables the probe. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 60;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

export interface EnrichJobOptions {
  pageSize: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  backfill: boolean;
  dryRun: boolean;
}

export const enrichJobOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): EnrichJobOptions => {
  const ctx = { context: JOB_NAME };
  const pageSize = requirePositiveInt(env[PAGE_SIZE_ENV], PAGE_SIZE_ENV, PAGE_SIZE_DEFAULT, ctx);
  return {
    pageSize,
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      { ...ctx, note: 'Use 0 to disable the live-activity probe.' }
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    backfill: args.includes('--backfill'),
    dryRun: args.includes('--dry-run'),
  };
};

// -- Cooperative pause -------------------------------------------------------

/** Probe `flowsheet` for a track row added in the last `lookbackSeconds`.
 * Returns `true` when activity is detected. `0` disables the probe.
 * Mirrors `jobs/concerts-genre-enrichment/job.ts`. */
export const checkLiveActivity = async (lookbackSeconds: number): Promise<boolean> => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM "wxyc_schema"."flowsheet"
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Loop: probe → if active, sleep pauseMs → re-probe. Returns when quiet. */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// -- LML fetch ----------------------------------------------------------------

/**
 * One artist's Discogs image lookup, gated by the job-owned limiter (one
 * token per artist — see `lml-limiter.ts`'s rate-accounting note).
 */
const fetchArtistImage = (discogsArtistId: number): Promise<{ image_url: string | null }> =>
  defaultLmlLimiter.run(async () => {
    const details = await getArtistDetails(discogsArtistId);
    return { image_url: details.image_url ?? null };
  });

// -- Entrypoint ----------------------------------------------------------------

export const runJob = async (options: EnrichJobOptions): Promise<Totals> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    page_size: options.pageSize,
    backfill: options.backfill,
    live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
    dry_run: options.dryRun,
  });

  return await runEnrichment(
    {
      loadCandidates: () => loadEnrichmentCandidates(options.backfill),
      fetchArtistImage,
      writeImages: writeConcertImages,
      awaitQuiet: () => awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs),
    },
    {
      pageSize: options.pageSize,
      dryRun: options.dryRun,
    }
  );
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = enrichJobOptions();
    const totals = await runJob(options);
    log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  } catch (err) {
    captureError(err, 'main');
    log('error', 'failed', `${JOB_NAME} failed: ${err instanceof Error ? err.message : String(err)}`, {
      error_message: err instanceof Error ? err.message : String(err),
      error_name: err instanceof Error ? err.name : null,
    });
    process.exitCode = 1;
  } finally {
    await closeLogger();
    await closeDatabaseConnection();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run against
// the mocked DB. Jest sets NODE_ENV='test'; production runs leave it unset (the
// Dockerfile sets no NODE_ENV), and any non-'test' value executes main().
if (process.env.NODE_ENV !== 'test') {
  void main();
}
