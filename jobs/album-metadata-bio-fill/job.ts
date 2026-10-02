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
 * The cohort, the dry run, and `runBatch` (BS#2777, BS#2781, BS#2778). The
 * execute loop that calls `runBatch` is BS#2779; until then `--execute` is
 * refused.
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
import {
  BULK_LOOKUP_INPUT_CAP,
  bulkLookupMetadata,
  type BulkLookupItem,
  type BulkLookupResultItem,
} from '@wxyc/lml-client';
import * as Sentry from '@sentry/node';
import {
  READ_TIMEOUT_DEFAULT,
  applyBioFill,
  countCohort,
  countEligible,
  enumerateCohort,
  type FillCandidate,
} from './cohort.js';
import { decideBioFill } from './decide.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-metadata-bio-fill' as const;

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

/** Per-item slice of the bulk fetch timeout, plus fixed slack. The shared LML
 * client's 30s default would otherwise fire mid-batch on a cascade-heavy chunk
 * (BS#1178). Mirrors `streaming-columns-drain`. */
export const PER_ITEM_TIMEOUT_MS = 5_000;
export const TIMEOUT_SLACK_MS = 5_000;
export const computeBulkTimeoutMs = (batchSize: number): number => batchSize * PER_ITEM_TIMEOUT_MS + TIMEOUT_SLACK_MS;

// -- Batch -------------------------------------------------------------------

export interface BatchResult {
  batchSize: number;
  /** One counter per `decideBioFill` verdict. */
  fill: number;
  no_match: number;
  untrusted: number;
  card_mismatch: number;
  no_bio: number;
  indeterminate: number;
  /** Of `fill`: rows actually updated, rows that had a bio by write time, and
   * rows whose UPDATE threw. The three sum to `fill`. */
  filled: number;
  skipped_raced: number;
  write_failed: number;
  /** Of `indeterminate`: results that arrived out of input order. */
  unexpected_index: number;
  /** The albums to ask again: LML did not answer for them, or their write
   * threw. A run reports these as exactly the rows a cursor resume would walk
   * past, so its length is `indeterminate + write_failed`. */
  indeterminateAlbumIds: number[];
}

export const emptyBatchResult = (batchSize: number): BatchResult => ({
  batchSize,
  fill: 0,
  no_match: 0,
  untrusted: 0,
  card_mismatch: 0,
  no_bio: 0,
  indeterminate: 0,
  filled: 0,
  skipped_raced: 0,
  write_failed: 0,
  unexpected_index: 0,
  indeterminateAlbumIds: [],
});

/**
 * `extended: true` on every item is load-bearing: it is one of the conditions
 * of LML's artist-identity gate (LML#504), which is the right gate for an
 * artist-scoped fill. Without it the bio rides LML's album gate instead.
 */
const buildBulkItems = (candidates: FillCandidate[]): BulkLookupItem[] =>
  candidates.map((c) => ({
    artist: c.artist_name,
    album: c.album_title,
    raw_message: `${c.artist_name} - ${c.album_title}`,
    extended: true,
  }));

/**
 * Resolve one chunk through LML and write the bio for each `fill` verdict.
 * Never called on a dry run.
 *
 * Only `fill` writes. A thrown bulk call (timeout, 5xx, network), or a 2xx
 * with no `results` array, leaves the whole chunk indeterminate. A write that
 * throws is counted `write_failed` for its own album and does not stop the
 * chunk.
 * `allowReleaseResolutionFallback` is deliberately not passed: like every
 * offline drain this stays off LML's per-row live Discogs path (BS#1815), at
 * the cost of the albums only a release pin can resolve.
 */
export const runBatch = async (candidates: FillCandidate[], options: { budgetMs: number }): Promise<BatchResult> => {
  const result = emptyBatchResult(candidates.length);
  if (candidates.length === 0) return result;

  let results: BulkLookupResultItem[];
  try {
    const response: { results?: unknown } | null = await bulkLookupMetadata(buildBulkItems(candidates), {
      caller: JOB_NAME,
      budgetMs: options.budgetMs,
      timeoutMs: computeBulkTimeoutMs(candidates.length),
    });
    // The client types `results` as an array but does not check it. A 2xx
    // whose body is not the bulk shape is no answer for any album, so it
    // takes the same path as a thrown call instead of failing the read below.
    if (!Array.isArray(response?.results)) throw new Error('LML bulk response carried no results array');
    results = response.results as BulkLookupResultItem[];
  } catch (err) {
    const extra = {
      size: candidates.length,
      first_album_id: candidates[0]?.album_id ?? null,
      last_album_id: candidates[candidates.length - 1]?.album_id ?? null,
    };
    log('warn', 'lml_batch_failed', 'no usable bulk response; whole batch left unwritten', {
      ...extra,
      error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    captureError(err, 'lml_batch_failed', extra);
    result.indeterminate = candidates.length;
    result.indeterminateAlbumIds = candidates.map((c) => c.album_id);
    return result;
  }

  for (const [position, candidate] of candidates.entries()) {
    const item = results[position];
    const verdict = decideBioFill(candidate, item, position);
    result[verdict.kind] += 1;

    if (verdict.kind === 'indeterminate') {
      result.indeterminateAlbumIds.push(candidate.album_id);
      if (verdict.unexpectedIndex) result.unexpected_index += 1;
      log('warn', 'lml_indeterminate', `no usable LML verdict for album_id=${candidate.album_id}; not written`, {
        album_id: candidate.album_id,
        status: item?.status ?? null,
        got_index: item?.index ?? null,
        error_message: item?.message ?? null,
      });
    } else if (verdict.kind === 'fill') {
      try {
        if (await applyBioFill(candidate.album_id, verdict.fill)) result.filled += 1;
        else result.skipped_raced += 1;
      } catch (err) {
        // One row's database error (a reset connection, a lock wait) is not
        // the run's. The album joins the retry list, which holds the resume
        // cursor at it, and the loop moves on to the next album.
        result.write_failed += 1;
        result.indeterminateAlbumIds.push(candidate.album_id);
        // Drizzle's own message is the statement and its parameters, the
        // whole bio included. What the database said is on `.cause`.
        const reason = (err as { cause?: unknown } | null)?.cause ?? err;
        log('warn', 'write_failed', `UPDATE threw for album_id=${candidate.album_id}; not written`, {
          album_id: candidate.album_id,
          error_message: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
        });
        captureError(err, 'write_failed', { album_id: candidate.album_id });
      }
    }
  }

  if (result.unexpected_index > 0) {
    Sentry.captureMessage(`${JOB_NAME}.unexpected_index`, {
      level: 'warning',
      tags: { source: JOB_NAME },
      extra: { unexpected_index: result.unexpected_index, batch_size: candidates.length },
      fingerprint: [JOB_NAME, 'unexpected_index'],
    });
  }

  return result;
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
    throw new Error(`${JOB_NAME}: --execute is not implemented yet (BS#2779); run without it for the plan`);
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
