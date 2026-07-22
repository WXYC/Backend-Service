/**
 * Nightly cron: enrich resolved concert headliners with artist-level Discogs
 * genres + bio via LML's bulk artist-genres endpoint (BS#1624, LML#781;
 * `bio` added BS#1734, LML#889).
 *
 * Chained after the concert artist resolvers (05:15 UTC strict/alias, 05:35 UTC
 * LML) so it only ever sees headliners those passes have resolved. For each
 * resolved headliner lacking an `artist_metadata` row it calls
 * `POST /api/v1/artists/genres/bulk` and persists `genres`/`styles`/`artist_bio`
 * keyed on the Discogs artist id — the key `GET /concerts` projects onto
 * `Concert.genres`/`Concert.artist_bio`. Default schedule `45 5 * * *` UTC.
 *
 * Modes:
 *   - default (nightly): upcoming-only candidate window (venue-local Eastern
 *     date), so genre budget is never spent on past shows the feed won't serve.
 *   - `--backfill`: drop the window and front-fill every existing resolved
 *     headliner — the one-time deploy backfill. Idempotent: the candidate
 *     anti-join + `ON CONFLICT DO NOTHING` make a re-run a no-op.
 *   - `--bio-backfill` (BS#1734, mutually exclusive with the above): a SEPARATE
 *     one-time pass over pre-existing genres-only `artist_metadata` rows (the
 *     nightly anti-join never revisits a row that already exists, so these
 *     rows would otherwise never pick up a bio). See `bio-backfill.ts`.
 *   - `--dry-run`: enumerate + log the plan; no LML calls, no writes. Applies
 *     to whichever mode is selected.
 *
 * Enrichment runs nightly server-to-server with the LML API key (merged at the
 * `@wxyc/lml-client` chokepoint from `LML_API_KEY`); it is never on any
 * listener hot path.
 *
 * The LML endpoint path + field names are the shipped LML#781 contract (merged
 * as LML#847), carried by `fetchArtistGenresBulk`, which enforces 1:1 index
 * alignment of the response before returning. LML's `source` discriminator
 * routes the write: `unavailable` (couldn't reach Discogs) is skipped and left
 * retryable; `cache`/`discogs_api`/`not_found` persist.
 *
 * Run procedure: see jobs/concerts-genre-enrichment/README.md.
 */

import { sql } from 'drizzle-orm';
import { closeDatabaseConnection, db, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { ARTIST_GENRES_BATCH_CAP, fetchArtistGenresBulk } from '@wxyc/lml-client';
import { defaultLmlLimiter } from './lml-limiter.js';
import { loadBioBackfillCandidates, loadEnrichmentCandidates } from './query.js';
import { runEnrichment, type Totals } from './orchestrate.js';
import { runBioBackfill, type BioBackfillTotals } from './bio-backfill.js';
import { applyBioBackfill, upsertArtistGenres } from './writer.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'concerts-genre-enrichment';

// -- Env knobs ---------------------------------------------------------------

/** Artists per LML page. Hard-capped at `ARTIST_GENRES_BATCH_CAP`. */
export const PAGE_SIZE_ENV = 'CONCERTS_GENRE_ENRICH_PAGE_SIZE';
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
  bioBackfill: boolean;
  dryRun: boolean;
}

export const enrichJobOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): EnrichJobOptions => {
  const ctx = { context: JOB_NAME };
  const pageSize = requirePositiveInt(env[PAGE_SIZE_ENV], PAGE_SIZE_ENV, PAGE_SIZE_DEFAULT, ctx);
  if (pageSize > ARTIST_GENRES_BATCH_CAP) {
    // Fail fast at parse time with an actionable message — the client would
    // otherwise throw the same ceiling per page after the run started.
    throw new Error(
      `[${JOB_NAME}] ${PAGE_SIZE_ENV}=${pageSize} exceeds the LML per-request cap of ${ARTIST_GENRES_BATCH_CAP}.`
    );
  }
  const backfill = args.includes('--backfill');
  const bioBackfill = args.includes('--bio-backfill');
  if (backfill && bioBackfill) {
    // Two different one-time modes over two different candidate sets and two
    // different writers — running both in one invocation would conflate their
    // totals/logging. Run them as separate invocations instead.
    throw new Error(`[${JOB_NAME}] --backfill and --bio-backfill are mutually exclusive; run them separately.`);
  }
  return {
    pageSize,
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      { ...ctx, note: 'Use 0 to disable the live-activity probe.' }
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    backfill,
    bioBackfill,
    dryRun: args.includes('--dry-run'),
  };
};

// -- Cooperative pause -------------------------------------------------------

/** Probe `flowsheet` for a track row added in the last `lookbackSeconds`.
 * Returns `true` when activity is detected. `0` disables the probe.
 * Mirrors `jobs/concerts-artist-lml-resolver/job.ts`. */
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
      fetchGenres: (items) => fetchArtistGenresBulk(items, { limiter: defaultLmlLimiter, caller: JOB_NAME }),
      upsert: upsertArtistGenres,
      awaitQuiet: () => awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs),
    },
    {
      pageSize: options.pageSize,
      dryRun: options.dryRun,
    }
  );
};

/** `--bio-backfill` mode (BS#1734) — see `bio-backfill.ts` module docblock. */
export const runBioBackfillJob = async (options: EnrichJobOptions): Promise<BioBackfillTotals> => {
  log('info', 'bio_backfill_started', `${JOB_NAME} bio backfill starting`, {
    page_size: options.pageSize,
    live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
    dry_run: options.dryRun,
  });

  return await runBioBackfill(
    {
      loadCandidates: loadBioBackfillCandidates,
      fetchGenres: (items) => fetchArtistGenresBulk(items, { limiter: defaultLmlLimiter, caller: JOB_NAME }),
      applyBioBackfill,
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
    const totals = options.bioBackfill ? await runBioBackfillJob(options) : await runJob(options);
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
