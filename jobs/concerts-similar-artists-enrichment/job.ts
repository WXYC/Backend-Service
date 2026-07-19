/**
 * Nightly cron: enrich upcoming curated IN-LIBRARY concert headliners with
 * artist-level affinity neighbors from the semantic-index graph (BS#1626,
 * On Tour R3b), so `GET /concerts` can project `Concert.similar_artists` for the
 * iOS On Tour "For You" shelf (WXYC/wxyc-ios-64#493).
 *
 * Chained AFTER the artist resolvers (05:15 strict/alias, 05:35 LML) and the
 * 05:45 genre enrichment, so it only ever sees headliners those passes have
 * FK-resolved (`concerts.headlining_artist_id` must be populated — the 05:35 LML
 * resolver closes that FK on singleton Discogs matches). For each distinct
 * in-library headliner it calls semantic-index's
 * `POST /graph/library-artists/neighbors/batch` (WXYC/semantic-index#354) and
 * OVERWRITES the top-K (K=20) neighbors on `artist_similar_artists`, keyed by
 * `artists.id` — the key `GET /concerts` LEFT-joins for `similar_artists`.
 * Default schedule `55 5 * * *` UTC.
 *
 * Modes:
 *   - default (nightly): upcoming-only cohort (venue-local Eastern date),
 *     re-fetched + overwritten every night to stay current with the graph.
 *   - `--backfill`: drop the window and front-fill every existing resolved
 *     in-library headliner — the one-time deploy backfill.
 *   - `--dry-run`: enumerate + log the plan; no network calls, no writes.
 *
 * The endpoint is public + no-auth (a bounded local SQLite read), so unlike the
 * LML jobs there is no API key, no shared chokepoint, and no rate limiter — see
 * neighbors-client.ts.
 */

import { sql } from 'drizzle-orm';
import { closeDatabaseConnection, db, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP, fetchGraphHealth, fetchNeighborsBatch } from './neighbors-client.js';
import { loadEnrichmentCandidates } from './query.js';
import { runEnrichment, type Totals } from './orchestrate.js';
import { overwriteNeighbors } from './writer.js';
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

export const runJob = async (options: EnrichJobOptions): Promise<Totals> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    limit: options.limit,
    chunk_size: options.chunkSize,
    backfill: options.backfill,
    live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
    dry_run: options.dryRun,
  });

  return await runEnrichment(
    {
      loadCandidates: () => loadEnrichmentCandidates(options.backfill),
      fetchNeighbors: (ids) => fetchNeighborsBatch(ids, options.limit),
      fetchHealth: fetchGraphHealth,
      overwrite: overwriteNeighbors,
      writeStation: writeStationPlays,
      awaitQuiet: () => awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs),
    },
    {
      limit: options.limit,
      chunkSize: options.chunkSize,
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
    // Surface a non-zero exit (so the cron alerts rather than reporting OK) on a
    // "wrote nothing AND something went wrong" run:
    //   - all_empty_skip: the NEIGHBORS null-wipe guard fired (mapping not rebuilt
    //     / fault) AND the run wrote no station plays either. A night that writes
    //     station plays (BS#1702) but has an all-empty neighbor sweep DID make
    //     progress, so it stays exit 0 — the loud `all_empty_sweep` error log
    //     still fires for visibility, but the run is not "wrote nothing."
    //   - wrote nothing while some signal failed — a total transport outage (every
    //     chunk threw → errors), a wholly-malformed sweep (malformed), or a write
    //     that threw (write_failed / station_write_failed). A PARTIAL failure that
    //     still wrote something (enriched/cleared/station_written > 0) stays exit
    //     0; the failure kinds already reach Sentry via captureError (chunk_failed
    //     / malformed_verdicts / overwrite_failed / station_write_failed), so a
    //     partial-omission run is visible without the alarm of a non-zero exit.
    // `station_empty_skip` is NOT a failure — semantic-index#369 being undeployed
    // is the expected pre-populate state (station_plays harmless while null).
    const wroteNothing = totals.enriched === 0 && totals.cleared === 0 && totals.station_written === 0;
    const somethingFailed =
      totals.errors > 0 || totals.malformed > 0 || totals.write_failed || totals.station_write_failed;
    if ((totals.all_empty_skip && totals.station_written === 0) || (wroteNothing && somethingFailed))
      process.exitCode = 1;
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
