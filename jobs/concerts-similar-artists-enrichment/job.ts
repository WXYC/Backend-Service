/**
 * Nightly cron: enrich upcoming curated concert headliners with artist-level
 * affinity neighbors from the semantic-index graph, so `GET /concerts` can
 * project `Concert.similar_artists` for the iOS On Tour "For You" shelf
 * (WXYC/wxyc-ios-64#493). Runs TWO lanes over the shared `runEnrichment`
 * orchestrator:
 *
 *   - LIBRARY lane (BS#1626): distinct IN-LIBRARY headliners
 *     (`concerts.headlining_artist_id IS NOT NULL`) → semantic-index's
 *     `POST /graph/library-artists/neighbors/batch` (#354, keyed by `artists.id`)
 *     → OVERWRITE `artist_similar_artists` keyed by `artists.id`.
 *   - DISCOGS lane (BS#1701): distinct DISCOGS-ONLY headliners
 *     (`headlining_artist_id IS NULL AND headlining_discogs_artist_id IS NOT
 *     NULL` — BS#1614's LML-minted touring artists absent from the WXYC library)
 *     → `POST /graph/discogs-artists/neighbors/batch` (#367, keyed by the Discogs
 *     id) → OVERWRITE `discogs_artist_similar_artists` keyed by the Discogs id.
 *
 * The two cohorts PARTITION the resolved-headliner space, so no headliner is
 * written to both tables. Both lanes return WXYC catalog neighbor ids, so
 * `GET /concerts` COALESCEs the two lanes (library wins). The orchestrator is
 * id-agnostic; the discogs lane translates its `discogs_artist_id` at the dep
 * boundary (below) into the orchestrator's `artist_id`-named seam and back.
 *
 * The LIBRARY lane also writes STATION PLAYS (BS#1702): it reads each headliner's
 * all-time play count off the same `neighbors/batch` response (`source_plays`,
 * #369) and UPSERTs `artist_station_plays` for `Concert.station_plays`. This is
 * an in-library, `artists.id`-keyed signal, so the discogs lane omits the
 * `writeStation` dep and does no station work (its #367 endpoint returns no
 * `source_plays`).
 *
 * Chained AFTER the artist resolvers (05:15 strict/alias, 05:35 LML) and the
 * 05:45 genre enrichment. Default schedule `55 5 * * *` UTC.
 *
 * Modes:
 *   - default (nightly): upcoming-only cohorts (venue-local Eastern date),
 *     re-fetched + overwritten every night to stay current with the graph.
 *   - `--backfill`: drop the window and front-fill every existing resolved
 *     headliner in BOTH lanes — the one-time deploy backfill.
 *   - `--dry-run`: enumerate + log the plan for both lanes; no network, no writes.
 *
 * The endpoint is public + no-auth (a bounded local SQLite read), so unlike the
 * LML jobs there is no API key, no shared chokepoint, and no rate limiter — see
 * neighbors-client.ts.
 */

import { sql } from 'drizzle-orm';
import { closeDatabaseConnection, db, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import {
  SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP,
  fetchDiscogsNeighborsBatch,
  fetchGraphHealth,
  fetchNeighborsBatch,
} from './neighbors-client.js';
import { loadEnrichmentCandidates } from './query.js';
import { loadDiscogsEnrichmentCandidates } from './discogs-query.js';
import { runEnrichment, type Totals } from './orchestrate.js';
import { overwriteNeighbors } from './writer.js';
import { overwriteDiscogsNeighbors } from './discogs-writer.js';
import { writeStationPlays } from './station-writer.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'concerts-similar-artists-enrichment';

// -- Env knobs ---------------------------------------------------------------

/** Top-K neighbors per headliner. K=20 is the R3b contract; capped at the endpoint cap. */
export const LIMIT_ENV = 'CONCERTS_SIMILAR_ENRICH_LIMIT';
export const LIMIT_DEFAULT = 20;

/** Ids per endpoint chunk. Hard-capped at `SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP` (100). */
export const CHUNK_SIZE_ENV = 'CONCERTS_SIMILAR_ENRICH_CHUNK_SIZE';
export const CHUNK_SIZE_DEFAULT = 100;

/** Cooperative-pause lookback window (seconds). `0` disables the probe. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 60;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

export interface EnrichJobOptions {
  limit: number;
  chunkSize: number;
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
  const limit = requirePositiveInt(env[LIMIT_ENV], LIMIT_ENV, LIMIT_DEFAULT, ctx);
  const chunkSize = requirePositiveInt(env[CHUNK_SIZE_ENV], CHUNK_SIZE_ENV, CHUNK_SIZE_DEFAULT, ctx);
  if (chunkSize > SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP) {
    // Fail fast at parse time with an actionable message — the client would
    // otherwise throw the same ceiling per chunk after the run started.
    throw new Error(
      `[${JOB_NAME}] ${CHUNK_SIZE_ENV}=${chunkSize} exceeds the semantic-index per-request cap of ${SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP}.`
    );
  }
  return {
    limit,
    chunkSize,
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

// -- Entrypoint ----------------------------------------------------------------

/** Log noun for the discogs lane's cohort (the library lane keeps the default). */
export const DISCOGS_COHORT_LABEL = 'Discogs-only headliners';

/** Per-lane `Totals`, one per `runEnrichment` pass. */
export type LaneTotals = { library: Totals; discogs: Totals };

/**
 * A lane "failed such that the cron should alert": either the neighbors null-wipe
 * guard fired (mapping not rebuilt / fault) AND no station plays were written
 * either, OR it wrote nothing (neighbors AND station) while some signal failed
 * (total transport outage, wholly-malformed sweep, or a thrown write). A PARTIAL
 * failure that still wrote something stays non-failing — the failure kinds
 * already reach Sentry via `captureError`. Evaluated PER LANE so a single failing
 * lane still alerts and isn't masked by the other lane's success.
 *
 * The station terms (BS#1702) are inert for the discogs lane (it has no
 * `writeStation`, so `station_written` is always 0 and `station_write_failed`
 * always false) — there the predicate reduces to the pre-station form. For the
 * library lane a night that wrote station plays but had an all-empty neighbor
 * sweep DID make progress and stays exit 0 (the loud `all_empty_sweep` log +
 * healthy-graph Sentry signal in orchestrate.ts keep a genuine fault alertable).
 * `station_empty_skip` is NOT a failure — an undeployed semantic-index#369 is the
 * expected pre-populate state.
 */
export const laneShouldAlert = (t: Totals): boolean => {
  const wroteNothing = t.enriched === 0 && t.cleared === 0 && t.station_written === 0;
  const somethingFailed = t.errors > 0 || t.malformed > 0 || t.write_failed || t.station_write_failed;
  return (t.all_empty_skip && t.station_written === 0) || (wroteNothing && somethingFailed);
};

export const runJob = async (options: EnrichJobOptions): Promise<LaneTotals> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    limit: options.limit,
    chunk_size: options.chunkSize,
    backfill: options.backfill,
    live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
    dry_run: options.dryRun,
  });

  const awaitQuiet = (): Promise<void> =>
    awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);
  const sharedOptions = { limit: options.limit, chunkSize: options.chunkSize, dryRun: options.dryRun };

  // Library lane (BS#1626): in-library headliners keyed on artists.id.
  const library = await runEnrichment(
    {
      loadCandidates: () => loadEnrichmentCandidates(options.backfill),
      fetchNeighbors: (ids) => fetchNeighborsBatch(ids, options.limit),
      fetchHealth: fetchGraphHealth,
      overwrite: overwriteNeighbors,
      // Library lane writes station plays (BS#1702); the discogs lane omits this
      // dep (station plays are an in-library, artists.id-keyed signal).
      writeStation: writeStationPlays,
      awaitQuiet,
    },
    sharedOptions
  );

  // Discogs lane (BS#1701): Discogs-only touring headliners keyed on the bare
  // Discogs id. The shared orchestrator's seam is named `artist_id`; translate
  // this lane's `discogs_artist_id` in on load and out on overwrite (two
  // `.map()`s) so each lane's own SQL stays honestly named.
  const discogs = await runEnrichment(
    {
      loadCandidates: async () =>
        (await loadDiscogsEnrichmentCandidates(options.backfill)).map((c) => ({ artist_id: c.discogs_artist_id })),
      fetchNeighbors: (ids) => fetchDiscogsNeighborsBatch(ids, options.limit),
      fetchHealth: fetchGraphHealth,
      overwrite: (upserts, deleteIds) =>
        overwriteDiscogsNeighbors(
          upserts.map((r) => ({ discogs_artist_id: r.artist_id, neighbors: r.neighbors })),
          deleteIds
        ),
      awaitQuiet,
    },
    { ...sharedOptions, cohortLabel: DISCOGS_COHORT_LABEL }
  );

  return { library, discogs };
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = enrichJobOptions();
    const { library, discogs } = await runJob(options);
    // Flatten each lane's Totals into prefixed top-level keys (`library_enriched`,
    // `discogs_cleared`, …) so the structured log stays flat/queryable rather than
    // nesting a `Totals` object per lane.
    const laneCtx = (prefix: string, t: Totals): Record<string, number | boolean> =>
      Object.fromEntries(Object.entries(t).map(([k, v]) => [`${prefix}_${k}`, v]));
    log('info', 'finished', `${JOB_NAME} done`, { ...laneCtx('library', library), ...laneCtx('discogs', discogs) });
    // Surface a non-zero exit (so the cron alerts rather than reporting OK) when
    // EITHER lane should alert — evaluated per-lane so one lane's success can't
    // mask the other's failure. See `laneShouldAlert`.
    if (laneShouldAlert(library) || laneShouldAlert(discogs)) process.exitCode = 1;
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
