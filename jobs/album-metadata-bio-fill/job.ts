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
 * ## How a run ends, and how to resume one
 *
 * Dry-run is the DEFAULT and makes zero LML calls: it reports the counts and
 * the batch plan and stops. `--execute` writes.
 *
 * Only a `fill` leaves the cohort. A no-match, a bio-less match and the rest
 * stay, so unlike `streaming-columns-drain` this job cannot resume by
 * re-enumerating — that would re-ask the whole residue — and "done" is
 * `reached_end: true` with nothing carried, not a cohort near zero. Each run
 * starts from the previous summary's `next_run` (`planResume`): a cursor
 * (`BIO_FILL_ALBUM_AFTER_ID`) past everything that run asked, and a list
 * (`BIO_FILL_ALBUM_IDS`) of what it could not settle, so nothing is skipped and
 * an album LML never answers for does not hold the chain in place.
 *
 * @see WXYC/Backend-Service#2775
 */

import {
  buildWaitForQuietPeriod,
  LiveActivityPauseCeilingExceededError,
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
  analyzeAlbumMetadata,
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

/**
 * Album list (BS#2786): a comma-separated list of album ids, still under the
 * cohort predicate and the eligibility conditions. With no cursor it is a
 * retry of just those albums. With a cursor it is carried into the cursor run:
 * the listed albums are asked first, then everything above the cursor, and
 * every listed id must be at or below it. A summary's `next_run` is exactly
 * such a pair, so the list holds at most as many ids as one summary lists.
 */
export const ALBUM_IDS_ENV = 'BIO_FILL_ALBUM_IDS';

/** How many unsettled album ids the summary lists, and so how many one retry
 * list may hold. The counts are always exact; the list is for re-running a
 * handful by hand, not for a full outage. */
export const INDETERMINATE_IDS_REPORT_CAP = 200;

/** `album_id` is a Postgres `integer`. */
const ALBUM_ID_MAX = 2_147_483_647;

/**
 * Unset or blank is no list. Anything else is a list or an error, never a
 * fallback: a typo read as "no list" would turn a three-album retry into a
 * run over the whole cohort.
 */
const resolveAlbumIds = (raw: string | undefined): number[] => {
  if (raw === undefined || raw.trim() === '') return [];
  const invalid = (why: string): Error =>
    new Error(`[${JOB_NAME}] Invalid ${ALBUM_IDS_ENV}=${JSON.stringify(raw)}: ${why}`);
  const ids = raw.split(',').map((token) => {
    const text = token.trim();
    const id = Number(text);
    if (!/^\d+$/.test(text) || id < 1 || id > ALBUM_ID_MAX) {
      throw invalid(`${JSON.stringify(text)} is not an album id; expected comma-separated positive integers.`);
    }
    return id;
  });
  const distinct = [...new Set(ids)].sort((a, b) => a - b);
  if (distinct.length > INDETERMINATE_IDS_REPORT_CAP) {
    throw invalid(`at most ${INDETERMINATE_IDS_REPORT_CAP} ids per run, got ${distinct.length}.`);
  }
  return distinct;
};

/** Abort after this many consecutive batches that settled nothing: LML
 * answered for no album, or every write the batch attempted threw. Either LML
 * or the database is down, and carrying on only walks the run past rows it
 * cannot process. */
export const MAX_CONSECUTIVE_FAILED_BATCHES_ENV = 'BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES';
export const MAX_CONSECUTIVE_FAILED_BATCHES_DEFAULT = 3;

/**
 * Abort after this many consecutive batches in which every album came back
 * `no_bio`; `0` disables. LML answers a breaker shed on its artist-details
 * step with a match and a null bio (`lookup/enrichment/top1.py`), the same
 * bytes as an artist with no profile, so a sustained shed fails no batch and
 * would walk the cursor to the end as a clean run. Its own knob with a
 * generous default, because a real run of bio-less albums exists too: the
 * cursor walks `album_id` order, and compilations or one profile-less
 * artist's albums can sit together.
 */
export const MAX_CONSECUTIVE_NO_BIO_BATCHES_ENV = 'BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES';
export const MAX_CONSECUTIVE_NO_BIO_BATCHES_DEFAULT = 10;

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
  albumIds: number[];
  maxConsecutiveFailedBatches: number;
  maxConsecutiveNoBioBatches: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  liveActivityMaxPauseMs: number;
  execute: boolean;
}

/** Dry-run is the DEFAULT. `--execute` is the only way to write. */
export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): FillOptions => {
  const ctx = { context: JOB_NAME };
  const afterAlbumId = requireNonNegativeInt(env[ALBUM_AFTER_ID_ENV], ALBUM_AFTER_ID_ENV, ALBUM_AFTER_ID_DEFAULT, ctx);
  const maxAlbums = requireNonNegativeInt(env[MAX_ALBUMS_ENV], MAX_ALBUMS_ENV, MAX_ALBUMS_DEFAULT, ctx);
  const albumIds = resolveAlbumIds(env[ALBUM_IDS_ENV]);
  // A listed id above the cursor would be asked by the cursor run anyway, so it
  // means the wrong cursor was copied. The listed ids sort first, so a cap
  // drops some of them only when it is smaller than the list.
  const aboveCursor = afterAlbumId > 0 ? albumIds.find((id) => id > afterAlbumId) : undefined;
  if (aboveCursor !== undefined) {
    throw new Error(
      `[${JOB_NAME}] ${ALBUM_IDS_ENV}: ${aboveCursor} is above ${ALBUM_AFTER_ID_ENV}=${afterAlbumId}; a list carried into a cursor run must be at or below the cursor.`
    );
  }
  if (maxAlbums > 0 && maxAlbums < albumIds.length) {
    throw new Error(
      `[${JOB_NAME}] ${MAX_ALBUMS_ENV}=${maxAlbums} is smaller than the ${albumIds.length} listed ids in ${ALBUM_IDS_ENV}; it would drop some of them unreported.`
    );
  }
  return {
    batchSize: resolveBatchSize(env[BATCH_SIZE_ENV]),
    ratePerMin: requirePositiveInt(env[RATE_PER_MIN_ENV], RATE_PER_MIN_ENV, RATE_PER_MIN_DEFAULT, ctx),
    budgetMs: requirePositiveInt(env[BUDGET_MS_ENV], BUDGET_MS_ENV, BUDGET_MS_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    maxAlbums,
    afterAlbumId,
    albumIds,
    maxConsecutiveFailedBatches: requirePositiveInt(
      env[MAX_CONSECUTIVE_FAILED_BATCHES_ENV],
      MAX_CONSECUTIVE_FAILED_BATCHES_ENV,
      MAX_CONSECUTIVE_FAILED_BATCHES_DEFAULT,
      ctx
    ),
    maxConsecutiveNoBioBatches: requireNonNegativeInt(
      env[MAX_CONSECUTIVE_NO_BIO_BATCHES_ENV],
      MAX_CONSECUTIVE_NO_BIO_BATCHES_ENV,
      MAX_CONSECUTIVE_NO_BIO_BATCHES_DEFAULT,
      { ...ctx, note: 'Use 0 to disable.' }
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

/** The per-verdict counters, shared by one batch's result and the run summary. */
type VerdictTotals = Omit<BatchResult, 'batchSize' | 'indeterminateAlbumIds'>;

const emptyTotals = (): VerdictTotals => ({
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
});

export const emptyBatchResult = (batchSize: number): BatchResult => ({
  batchSize,
  ...emptyTotals(),
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
        // A degraded lookup is labelled `match`; this says what was shed.
        degraded_reason: item?.lookup?.degraded_reason ?? null,
        got_index: item?.index ?? null,
        error_message: item?.message ?? null,
      });
    } else if (verdict.kind === 'fill') {
      try {
        if (await applyBioFill(candidate.album_id, verdict.fill)) result.filled += 1;
        else result.skipped_raced += 1;
      } catch (err) {
        // One row's database error (a reset connection, a lock wait) is not
        // the run's. The album is carried into the next run like an unanswered
        // one, and the loop moves on to the next album.
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

/** Thrown when `maxConsecutiveFailedBatches` batches in a row settled
 * nothing. Carried through the accounting and rethrown, like the pause
 * ceiling, so the run exits non-zero with its partial totals logged. The
 * counter cannot tell a dead LML from a dead database, so the message names
 * both and points at the log lines that can. */
export class ConsecutiveFailedBatchesError extends Error {
  constructor(batches: number) {
    super(
      `${JOB_NAME}: ${batches} consecutive batches settled nothing (no usable LML verdict, or every write threw); see the lml_batch_failed, lml_indeterminate and write_failed lines for which; aborting`
    );
    this.name = 'ConsecutiveFailedBatchesError';
  }
}

/** Thrown when `maxConsecutiveNoBioBatches` batches in a row came back
 * entirely `no_bio`. Carried and rethrown like the abort above. */
export class ConsecutiveNoBioBatchesError extends Error {
  constructor(batches: number) {
    super(
      `${JOB_NAME}: ${batches} consecutive batches came back entirely no_bio. LML's artist-details breaker is probably open: a shed bio reads as "no profile" from here. The streak's albums are carried in next_run; run it once LML is healthy, or raise or zero ${MAX_CONSECUTIVE_NO_BIO_BATCHES_ENV} if these albums really have no bios; aborting`
    );
    this.name = 'ConsecutiveNoBioBatchesError';
  }
}

export interface FillSummary extends VerdictTotals {
  /** Every bio-less Discogs-matched row, before and after. Their difference
   * is the fills and nothing else — the non-fill residue stays in the cohort. */
  cohortBefore: number;
  cohortAfter: number;
  /** The drainable subset, ignoring the cap and the cursor. */
  eligible: number;
  /** Permanently excluded: no usable artist name, or marked not-on-Discogs.
   * Never the cap's remainder — that is remaining work, not exclusion. */
  excluded: number;
  /** Rows this run set out to process: above the cursor, under the cap. */
  enumerated: number;
  batches: number;
  /** The last album a batch was sent for, or null if none was. */
  last_album_id: number | null;
  /** The list-free fallback: safe to pass as `BIO_FILL_ALBUM_AFTER_ID` on its
   * own, because it sits below every album this run left unsettled, so a
   * resume never skips one. It stalls where `next_run` does not: an album that
   * is never answered holds it in place. `null` on a retry run, which has no
   * cursor. */
  resume_after_album_id: number | null;
  /** Up to `INDETERMINATE_IDS_REPORT_CAP` of the albums this run leaves for
   * the next one below `next_run`'s cursor: unanswered, `write_failed`, the
   * albums of a no-bio streak that aborted it, and listed albums it never
   * reached. `indeterminate` and `write_failed` are always the exact counts. */
  indeterminate_album_ids: number[];
  /** What to run next: the cursor past everything this run asked, carrying the
   * albums it left as the list. When those outgrow one list, the first 200 are
   * carried and the cursor stops just below the first album that did not fit.
   * `null` when a retry run left nothing, and on a dry run. */
  next_run: NextRun | null;
  execute: boolean;
  /** True when the loop ended before its last batch: a signal, the pause, or
   * an abort. Without it those are indistinguishable from a completed run. */
  stopped_early: boolean;
  /** True when the run asked every album its cursor and list covered: it was
   * not stopped or aborted, and the cap did not cut the enumeration. A capped
   * run that used its whole cap reports false, since more may lie above. */
  reached_end: boolean;
}

/** The environment that starts the next run where this one left off. */
export interface NextRun {
  BIO_FILL_ALBUM_AFTER_ID: number;
  BIO_FILL_ALBUM_IDS: string;
}

export interface ResumePlan {
  /** Every album the next run must ask that its cursor does not reach, in
   * `album_id` order. */
  pending: number[];
  resumeAfterAlbumId: number | null;
  nextRun: NextRun | null;
}

/**
 * Where a run leaves its work for the next one (BS#2786). The cursor moves past
 * the last album asked, and everything the run asked but could not settle rides
 * along as the next run's list: an album LML never answers for then costs one
 * retry per run, where a frozen cursor made every later run re-ask the whole
 * stretch above it. More than one list's worth carries the first list and
 * stops the cursor below the rest. Pure; called after each batch, so the
 * summary is current however the run ends, and once more after the loop.
 */
export const planResume = (state: {
  /** Enumerated album ids, in the order they were asked. */
  candidateIds: readonly number[];
  /** How many of them were in a batch that came back. */
  processed: number;
  /** Asked but not settled: unanswered, or the write threw. */
  unsettledIds: readonly number[];
  /** Index of a no-bio streak's first album, when that guard aborted the run.
   * Every album in it looked settled, and a breaker shed may have hit any. */
  noBioStreakStart?: number;
  afterAlbumId: number;
  /** A list with no cursor: only the listed albums, and no cursor to move. */
  retryOnly: boolean;
}): ResumePlan => {
  const { candidateIds, processed, afterAlbumId, retryOnly } = state;
  const cursor = processed > 0 ? Math.max(afterAlbumId, candidateIds[processed - 1]) : afterAlbumId;
  // Albums never reached above the cursor are the cursor's; below it, only a
  // carried list's albums can be, and those have to be listed again.
  const unreached = candidateIds.slice(processed).filter((id) => retryOnly || id <= cursor);
  const pending = [
    ...new Set([
      ...state.unsettledIds,
      ...candidateIds.slice(state.noBioStreakStart ?? processed, processed),
      ...unreached,
    ]),
  ].sort((a, b) => a - b);

  if (retryOnly) {
    return {
      pending,
      resumeAfterAlbumId: null,
      nextRun: pending.length > 0 ? { BIO_FILL_ALBUM_AFTER_ID: 0, BIO_FILL_ALBUM_IDS: pending.join(',') } : null,
    };
  }
  const resumeAfterAlbumId = pending.length > 0 ? pending[0] - 1 : cursor;
  // More than one list holds: carry the first full list and stop the cursor
  // just below the first album that did not fit, so every pending album at or
  // below it is listed and the rest are above it. Rewinding to the first
  // pending album instead re-asked the whole residue and, under a sustained
  // shed, overflowed again every run.
  const carried = pending.slice(0, INDETERMINATE_IDS_REPORT_CAP);
  const nextCursor = pending.length > carried.length ? pending[carried.length] - 1 : cursor;
  return {
    pending,
    resumeAfterAlbumId,
    nextRun: { BIO_FILL_ALBUM_AFTER_ID: nextCursor, BIO_FILL_ALBUM_IDS: carried.join(',') },
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Cooperative stop, flipped by SIGTERM/SIGINT in `main`. The in-flight batch
 * always finishes; its writes are committed per album. */
let stopRequested = false;
export const requestStop = (): void => {
  stopRequested = true;
};
export const __resetStopForTesting = (): void => {
  stopRequested = false;
};

/** `sleep`, but wakes early once a stop has been requested. */
const stopAwareSleep = async (ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !stopRequested) {
    await sleep(Math.min(500, deadline - Date.now()));
  }
};

export const runFill = async (options: FillOptions): Promise<FillSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: options.batchSize,
    rate_per_min: options.ratePerMin,
    max_albums: options.maxAlbums,
    after_album_id: options.afterAlbumId,
    album_ids: options.albumIds,
    execute: options.execute,
  });

  const cohortBefore = await countCohort(options.readTimeoutMs);
  const eligible = await countEligible(options.readTimeoutMs);
  const candidates = await enumerateCohort({
    limit: options.maxAlbums,
    afterAlbumId: options.afterAlbumId,
    albumIds: options.albumIds,
    timeoutMs: options.readTimeoutMs,
  });
  const retryOnly = options.albumIds.length > 0 && options.afterAlbumId === 0;
  if (options.albumIds.length > 0) {
    const enumeratedIds = new Set(candidates.map((c) => c.album_id));
    const missing = options.albumIds.filter((id) => !enumeratedIds.has(id));
    if (missing.length > 0) {
      log(
        'warn',
        'listed_ids_not_in_cohort',
        `${missing.length} listed albums have a bio by now or are not eligible; not asked`,
        { album_ids: missing }
      );
    }
  }
  const batches: FillCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += options.batchSize) {
    batches.push(candidates.slice(i, i + options.batchSize));
  }

  const summary: FillSummary = {
    ...emptyTotals(),
    cohortBefore,
    cohortAfter: cohortBefore,
    eligible,
    excluded: cohortBefore - eligible,
    enumerated: candidates.length,
    batches: batches.length,
    last_album_id: null,
    resume_after_album_id: retryOnly ? null : options.afterAlbumId,
    indeterminate_album_ids: [],
    next_run: null,
    execute: options.execute,
    stopped_early: false,
    reached_end: false,
  };

  if (!options.execute) {
    // A dry run stops here, before any LML call. An operator sizing the job
    // must not be able to spend the Discogs quota by asking for a plan.
    log(
      'info',
      'dry_run_plan',
      `DRY RUN — no LML calls, no writes. Would run ${batches.length} batches of up to ${options.batchSize}. Pass --execute to write.`,
      { ...summary, estimated_minutes: Math.ceil(batches.length / options.ratePerMin) }
    );
    return summary;
  }

  // Shared cooperative pause (BS#2147): carries the cumulative
  // `LIVE_ACTIVITY_MAX_PAUSE_MS` ceiling and a fail-open probe.
  const waitForQuietPeriod = buildWaitForQuietPeriod({
    lookbackSeconds: options.liveActivityLookbackSeconds,
    pauseMs: options.liveActivityPauseMs,
    maxTotalPauseMs: options.liveActivityMaxPauseMs,
    shouldStop: () => stopRequested,
    onPause: (info) =>
      log('info', 'live_activity_pause', `DJ activity detected; pausing ${info.pauseMs}ms`, {
        paused_ms_so_far: info.pausedMs,
      }),
    onProbeError: (err) => captureError(err, 'live_activity_probe'),
    onBudgetExhausted: (pausedMs) =>
      log('warn', 'live_activity_budget_exhausted', 'cumulative pause ceiling hit; stopping the run', {
        paused_ms: pausedMs,
      }),
  });

  const interBatchSleepMs = Math.floor(60_000 / options.ratePerMin);
  // An abort is carried, not thrown from inside the loop, so the ANALYZE and
  // the cohort re-count below still run against rows already written. It is
  // rethrown after that accounting.
  let abort: Error | undefined;
  let consecutiveFailedBatches = 0;
  let consecutiveNoBioBatches = 0;
  // What `planResume` needs: how many candidates were in a batch that came
  // back, which of those were not settled, and, after a no-bio abort, where
  // the streak began.
  const candidateIds = candidates.map((c) => c.album_id);
  const unsettledIds: number[] = [];
  let processed = 0;
  let noBioStreakStart: number | undefined;
  const applyResumePlan = (): void => {
    const plan = planResume({
      candidateIds,
      processed,
      unsettledIds,
      noBioStreakStart,
      afterAlbumId: options.afterAlbumId,
      retryOnly,
    });
    summary.resume_after_album_id = plan.resumeAfterAlbumId;
    summary.indeterminate_album_ids = plan.pending.slice(0, INDETERMINATE_IDS_REPORT_CAP);
    summary.next_run = plan.nextRun;
  };

  for (const [b, batch] of batches.entries()) {
    // The shared pause consults `shouldStop` too, but not when the probe is
    // disabled (LIVE_ACTIVITY_LOOKBACK_SECONDS=0), so the loop has its own guard.
    if (stopRequested) {
      log('warn', 'stopped', 'graceful stop requested; ending before the next batch', { batches_done: b });
      summary.stopped_early = true;
      break;
    }
    // `waitForQuietPeriod()` returns a STOP signal: true means stop the loop.
    // The donor's first cut had this inverted and exited 0 having done nothing.
    try {
      if (await waitForQuietPeriod()) {
        summary.stopped_early = true;
        break;
      }
    } catch (err) {
      // Deliberately not narrowed to the ceiling class: anything escaping the
      // pause must reach the accounting below. The class only picks the label.
      const step =
        err instanceof LiveActivityPauseCeilingExceededError
          ? 'live_activity_pause_ceiling_exceeded'
          : 'live_activity_pause_failed';
      captureError(err, step, { batches_done: b, of: batches.length });
      abort = toError(err);
      break;
    }

    const result = await runBatch(batch, { budgetMs: options.budgetMs });
    processed += batch.length;
    const { batchSize, indeterminateAlbumIds, ...counts } = result;
    for (const [key, value] of Object.entries(counts) as Array<[keyof VerdictTotals, number]>) {
      summary[key] += value;
    }
    unsettledIds.push(...indeterminateAlbumIds);
    summary.last_album_id = batch[batch.length - 1].album_id;
    applyResumePlan();
    log('info', 'batch_done', `batch ${b + 1}/${batches.length}`, {
      batch: b + 1,
      of: batches.length,
      ...counts,
      last_album_id: summary.last_album_id,
      resume_after_album_id: summary.resume_after_album_id,
      // So a run killed without a summary line still leaves a next run.
      next_run: summary.next_run,
    });

    // A batch settled nothing when LML answered for none of it, or when every
    // write it attempted threw. The second arm is not "every album failed": a
    // dead database fails the fills while LML still returns its ordinary share
    // of no_bio and no_match, and that batch must count or the run spins.
    const settledNothing =
      result.indeterminate === batchSize || (result.write_failed > 0 && result.write_failed === result.fill);
    consecutiveFailedBatches = settledNothing ? consecutiveFailedBatches + 1 : 0;
    consecutiveNoBioBatches = result.no_bio === batchSize ? consecutiveNoBioBatches + 1 : 0;
    if (consecutiveFailedBatches >= options.maxConsecutiveFailedBatches) {
      abort = new ConsecutiveFailedBatchesError(consecutiveFailedBatches);
    } else if (
      options.maxConsecutiveNoBioBatches > 0 &&
      consecutiveNoBioBatches >= options.maxConsecutiveNoBioBatches
    ) {
      // Every row in the streak looked answered, so the cursor walked through
      // it. `planResume` lists its albums for the next run, or a resume would
      // never re-ask what the shed took.
      noBioStreakStart = processed - batches.slice(b + 1 - consecutiveNoBioBatches, b + 1).flat().length;
      abort = new ConsecutiveNoBioBatchesError(consecutiveNoBioBatches);
    }
    if (abort) {
      const step =
        abort instanceof ConsecutiveNoBioBatchesError ? 'consecutive_no_bio_batches' : 'consecutive_failed_batches';
      captureError(abort, step, { batches_done: b + 1, of: batches.length });
      break;
    }
    if (b < batches.length - 1) await stopAwareSleep(interBatchSleepMs);
  }

  // Once more after the loop, for a no-bio streak or a run that never reached
  // a batch. A capped run that used its whole cap may have more above it.
  applyResumePlan();
  summary.reached_end =
    abort === undefined &&
    !summary.stopped_early &&
    (retryOnly || options.maxAlbums === 0 || candidates.length < options.maxAlbums);

  // The accounting reads the database too, and a run that aborted because the
  // database went away will fail here as well. That must not cost the summary
  // line below, so the error is held; `cohortAfter` then keeps the before-count.
  let accountingError: Error | undefined;
  try {
    if (summary.filled > 0) await analyzeAlbumMetadata();
    summary.cohortAfter = await countCohort(options.readTimeoutMs);
  } catch (err) {
    accountingError = toError(err);
    captureError(err, 'accounting_failed');
  }

  const failure = abort ?? accountingError;
  if (failure) {
    // `main`'s `finished` line will not run once this throws, so this log is
    // what preserves the partial totals and the resume point.
    summary.stopped_early ||= abort !== undefined;
    const how = abort ? 'aborted early' : 'could not finish its accounting';
    log('error', 'summary', `${JOB_NAME} ${how}: ${failure.message}`, {
      ...summary,
      accounting_failed: accountingError !== undefined,
    });
    throw failure;
  }
  return summary;
};

const registerSignalHandlers = (): void => {
  const onSignal = (signal: NodeJS.Signals) => {
    log('warn', 'signal', `received ${signal}; requesting graceful stop`, { signal });
    requestStop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
};

export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  registerSignalHandlers();

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
