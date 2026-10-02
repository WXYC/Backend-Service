/**
 * album-metadata-bio-fill — one-shot fill for `album_metadata` rows that carry
 * a Discogs match and no `artist_bio` (BS#2775).
 *
 * ## Why these rows exist and why nothing heals them
 *
 * Roughly 39% of Discogs-matched `album_metadata` rows have no bio, and for
 * most of those Discogs has one. They were written by one-shot backfills and
 * by repairs that rewrote a single column, not by the live enrichment worker.
 * `apps/enrichment-worker/precheck.ts` (BS#1747) then skips LML for any album
 * whose row already carries artwork or a Discogs URL plus a streaming URL, and
 * a null bio is not one of the things that re-opens a row. So the writers that
 * produced the gap no longer run and the one that could repair it is gated
 * off.
 *
 * ## What it writes
 *
 * `artist_bio` and `artist_wikipedia_url`, fill-null only. Nothing else. LML
 * resolves by search and lands on a different release than the stored one
 * about 40% of the time for this cohort, so anything release-scoped — artwork,
 * `discogs_url`, year, streaming links, and the BS#1336 extended columns that
 * WXYC/Backend-Service#1442 owns — is deliberately left alone.
 *
 * ## State of this file
 *
 * The cohort and the dry run (BS#2777). The verdict and write are BS#2778 and
 * the execute loop is BS#2779; until then `--execute` is refused.
 *
 * Dry-run is the DEFAULT and makes zero LML calls: it reports the counts and
 * the batch plan and stops.
 *
 * @see WXYC/Backend-Service#2775
 */

import {
  closeDatabaseConnection,
  requireNonNegativeInt,
  requirePositiveInt,
  resolveLiveActivityMaxPauseMs,
  resolveLiveActivityPauseMs,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
} from '@wxyc/database';
import { BULK_LOOKUP_INPUT_CAP } from '@wxyc/lml-client';
import { READ_TIMEOUT_DEFAULT, countCohort, countEligible, enumerateCohort } from './cohort.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-metadata-bio-fill';

// -- Knobs -------------------------------------------------------------------

/** Items per LML bulk request. 5 is the BS#1197 ceiling under live
 * `enrichment-worker` contention; LML hard-caps at `BULK_LOOKUP_INPUT_CAP`. */
export const BATCH_SIZE_ENV = 'BIO_FILL_BULK_BATCH_SIZE';
export const BATCH_SIZE_DEFAULT = 5;

/**
 * The batch size, refused above the LML client's cap. `bulkLookupMetadata`
 * throws client-side past it, and a dry run never calls it, so without this
 * an oversize value plans cleanly and then aborts the execute run as
 * consecutive failed batches.
 */
const resolveBatchSize = (raw: string | undefined): number => {
  const batchSize = requirePositiveInt(raw, BATCH_SIZE_ENV, BATCH_SIZE_DEFAULT, { context: JOB_NAME });
  if (batchSize > BULK_LOOKUP_INPUT_CAP) {
    throw new Error(
      `[${JOB_NAME}] Invalid ${BATCH_SIZE_ENV}=${JSON.stringify(raw)}: must be at most ${BULK_LOOKUP_INPUT_CAP}, LML's per-request bulk cap.`
    );
  }
  return batchSize;
};

/** Batches per minute. The default is the donor's conservative 5 albums/min;
 * the README sizes a real run. */
export const RATE_PER_MIN_ENV = 'BIO_FILL_BULK_RATE_PER_MIN';
export const RATE_PER_MIN_DEFAULT = 1;

/** Per-item budget forwarded to LML as `X-Caller-Budget-Ms`. */
export const BUDGET_MS_ENV = 'BIO_FILL_BULK_BUDGET_MS';
export const BUDGET_MS_DEFAULT = 25_000;

export const READ_TIMEOUT_ENV = 'BIO_FILL_READ_TIMEOUT_MS';

/** Stop after this many albums; `0` is no cap. A bounded first run is the
 * canary, and bounded runs chained by cursor are how the full cohort drains. */
export const MAX_ALBUMS_ENV = 'BIO_FILL_MAX_ALBUMS';
export const MAX_ALBUMS_DEFAULT = 0;

/**
 * Resume cursor: only albums with `album_id` above this are enumerated.
 *
 * `streaming-columns-drain` needs no cursor because every row it settles
 * leaves its cohort. Here only a `fill` does — a no-match or a bio-less match
 * stays — so a re-enumeration would re-ask the whole residue below the abort
 * point.
 */
export const ALBUM_AFTER_ID_ENV = 'BIO_FILL_ALBUM_AFTER_ID';
export const ALBUM_AFTER_ID_DEFAULT = 0;

/** Abort after this many consecutive batches with no definitive verdict at
 * all: LML is down, and carrying on only walks the cursor past rows it cannot
 * process. Consumed by the execute loop (BS#2779). */
export const MAX_CONSECUTIVE_FAILED_BATCHES_ENV = 'BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES';
export const MAX_CONSECUTIVE_FAILED_BATCHES_DEFAULT = 3;

/** Cooperative-pause lookback, shared with every sibling drain (BS#2147). */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 300;

export interface FillOptions {
  batchSize: number;
  ratePerMin: number;
  budgetMs: number;
  readTimeoutMs: number;
  maxAlbums: number;
  afterAlbumId: number;
  maxConsecutiveFailedBatches: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  liveActivityMaxPauseMs: number;
  execute: boolean;
}

/** Dry-run is the DEFAULT. `--execute` is the only way to write. */
export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): FillOptions => {
  const ctx = { context: JOB_NAME };
  return {
    batchSize: resolveBatchSize(env[BATCH_SIZE_ENV]),
    ratePerMin: requirePositiveInt(env[RATE_PER_MIN_ENV], RATE_PER_MIN_ENV, RATE_PER_MIN_DEFAULT, ctx),
    budgetMs: requirePositiveInt(env[BUDGET_MS_ENV], BUDGET_MS_ENV, BUDGET_MS_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    maxAlbums: requireNonNegativeInt(env[MAX_ALBUMS_ENV], MAX_ALBUMS_ENV, MAX_ALBUMS_DEFAULT, ctx),
    afterAlbumId: requireNonNegativeInt(env[ALBUM_AFTER_ID_ENV], ALBUM_AFTER_ID_ENV, ALBUM_AFTER_ID_DEFAULT, ctx),
    maxConsecutiveFailedBatches: requirePositiveInt(
      env[MAX_CONSECUTIVE_FAILED_BATCHES_ENV],
      MAX_CONSECUTIVE_FAILED_BATCHES_ENV,
      MAX_CONSECUTIVE_FAILED_BATCHES_DEFAULT,
      ctx
    ),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      ctx
    ),
    liveActivityPauseMs: resolveLiveActivityPauseMs(env['LIVE_ACTIVITY_PAUSE_MS']),
    liveActivityMaxPauseMs: resolveLiveActivityMaxPauseMs(env[LIVE_ACTIVITY_MAX_PAUSE_MS_ENV]),
    execute: args.includes('--execute'),
  };
};

// -- Orchestration -----------------------------------------------------------

export interface FillSummary {
  /** Every bio-less Discogs-matched row. */
  cohortBefore: number;
  /** The drainable subset, ignoring the cap and the cursor. */
  eligible: number;
  /** Permanently excluded: no usable artist name, or marked not-on-Discogs.
   * Never the cap's remainder — that is remaining work, not exclusion. */
  excluded: number;
  /** Rows this run would process: above the cursor, under the cap. */
  enumerated: number;
  batches: number;
  execute: boolean;
}

export const runFill = async (options: FillOptions): Promise<FillSummary> => {
  if (options.execute) {
    throw new Error(`${JOB_NAME}: --execute is not implemented yet (BS#2778, BS#2779); run without it for the plan`);
  }

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: options.batchSize,
    rate_per_min: options.ratePerMin,
    max_albums: options.maxAlbums,
    after_album_id: options.afterAlbumId,
    execute: options.execute,
  });

  const cohortBefore = await countCohort(options.readTimeoutMs);
  const eligible = await countEligible(options.readTimeoutMs);
  const candidates = await enumerateCohort(options.maxAlbums, options.afterAlbumId, options.readTimeoutMs);
  const summary: FillSummary = {
    cohortBefore,
    eligible,
    excluded: cohortBefore - eligible,
    enumerated: candidates.length,
    batches: Math.ceil(candidates.length / options.batchSize),
    execute: options.execute,
  };

  // A dry run stops here, before any LML call. An operator sizing the job
  // must not be able to spend the Discogs quota by asking for a plan.
  log(
    'info',
    'dry_run_plan',
    `DRY RUN — no LML calls, no writes. Would run ${summary.batches} batches of up to ${options.batchSize}. Pass --execute to write.`,
    { ...summary, estimated_minutes: Math.ceil(summary.batches / options.ratePerMin) }
  );
  return summary;
};

export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const summary = await runFill(resolveOptions());
    log('info', 'finished', `${JOB_NAME} done`, { ...summary });
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

// Guard the auto-invoke so jest's module load doesn't fire a stray run (same
// rationale as `streaming-columns-drain#main`).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
