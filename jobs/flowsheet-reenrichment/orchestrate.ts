/**
 * One-shot orchestrator for the flowsheet-reenrichment drain (BS#1433).
 *
 * Iterates flowsheet rows matching:
 *   metadata_status = 'enriched_no_match'
 *   AND album_id IS NULL
 *   AND artist_name IS NOT NULL
 *   AND add_time < $BACKFILL_CUTOFF_TS
 *
 * Per-row (not bulk): the cohort is cascade-bound on cold Discogs lookups
 * (the library-miss-by-definition path LML#583 introduces). Per-row gating
 * shares the LML 50/min Discogs budget gently with real-time traffic.
 *
 * Cooperative pause: same pattern as flowsheet-metadata-backfill (#735).
 *
 * The `lookup` and `enrich` functions are injected so tests can drive the
 * orchestration without a live LML or DB.
 *
 * Linkage-race note (review-round-2): a parallel linkage resolver can flip
 * album_id non-null between the orchestrator's SELECT and reenrichRow's
 * UPDATE. The UPDATE's `album_id IS NULL` guard then returns 0 rows
 * (counted as `match_raced`) — same as a true update race — and the row
 * is left in `enriched_no_match` with a linked album_id. The CDC consumer
 * never revisits `enriched_no_match`. README's post-run audit SQL catches
 * any such orphans; the run logs every `match_raced` as a `WARN
 * possible_linkage_race` so the runbook step is grep-able.
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  checkLiveActivity as defaultCheckLiveActivity,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
  requireNonNegativeInt,
  requirePositiveInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import type { ReenrichRow, ReenrichOutcome } from './enrich.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'flowsheet-reenrichment';

export const BATCH_SIZE = 100;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);

/**
 * Retry budget for loadBatch's SELECT. A transient RDS failover or network
 * blip should not abort a 10-15h drain (we'd waste hours of LML budget
 * re-walking already-processed rows on the next run). Three attempts with
 * 500ms / 2s / 5s backoff covers typical multi-AZ failovers.
 */
const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000, 5000];

export const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'BACKFILL_BATCH_SIZE', BATCH_SIZE);

/**
 * Throws when BACKFILL_CUTOFF_TS is missing, syntactically invalid, or in
 * the future. Fail-fast so the operator sees a clear message rather than a
 * Postgres ::timestamptz cast stack trace inside the first loadBatch.
 *
 * Future-date guard catches the fat-finger '2027' typo that would otherwise
 * widen the cohort to include legitimately-terminal post-LML#583 rows,
 * burning Discogs budget for rows that will never flip.
 */
export const resolveCutoffTs = (raw: string | undefined = process.env.BACKFILL_CUTOFF_TS): string => {
  if (!raw) {
    throw new Error('BACKFILL_CUTOFF_TS is required; set to the LML#583 merge timestamp (2026-06-16T17:53:53Z).');
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `BACKFILL_CUTOFF_TS=${JSON.stringify(raw)} is not a valid ISO 8601 timestamp (e.g. 2026-06-16T17:53:53Z).`
    );
  }
  if (parsed > Date.now()) {
    throw new Error(
      `BACKFILL_CUTOFF_TS=${JSON.stringify(raw)} is in the future; cohort would include legitimately-terminal post-fix rows. Use the LML#583 merge timestamp.`
    );
  }
  return raw;
};

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable the cooperative pause.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_PAUSE_MS', LIVE_ACTIVITY_PAUSE_MS_DEFAULT, { unit: 'ms' });

export type LookupResult = { response: LookupResponse; cacheHit: boolean };
export type LookupFn = (artist: string, album?: string, track?: string) => Promise<LookupResult>;
export type EnrichFn = (row: ReenrichRow, response: LookupResponse) => Promise<ReenrichOutcome>;

export type Totals = {
  scanned: number;
  match: number;
  match_raced: number;
  still_no_match: number;
  lml_error: number;
  db_error: number;
};

export type RunResult = {
  totals: Totals;
  flipped: number;
};

/**
 * Cooperative cancellation flag for graceful shutdown on SIGTERM. The
 * runReenrichment loop checks this between batches; `requestStop()` lets
 * job.ts's signal handler abort the run mid-flight without losing the
 * `finally` block's Sentry flush + DB close.
 */
let stopRequested = false;
export const requestStop = (): void => {
  stopRequested = true;
};
export const isStopRequested = (): boolean => stopRequested;
/** Test-only seam to reset the singleton between tests. */
export const __resetStopForTesting = (): void => {
  stopRequested = false;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string =>
  // Defend against non-Error throws (`throw 'string'`, `throw { code: x }`) —
  // `(err as Error).message` would emit `undefined` and the JSON logger
  // would drop the key, leaving operators with no signal at all.
  error instanceof Error ? error.message : String(error);

const loadBatchOnce = async (afterId: number, batchSize: number, cutoffTs: string): Promise<ReenrichRow[]> => {
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title",
      "track_title"
    FROM ${FLOWSHEET_TABLE}
    WHERE "metadata_status" = 'enriched_no_match'
      AND "album_id" IS NULL
      AND "artist_name" IS NOT NULL
      AND "add_time" < ${cutoffTs}::timestamptz
      AND "id" > ${afterId}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as ReenrichRow[];
  return rows ?? [];
};

/**
 * loadBatch with transient-error retry. A momentary RDS hiccup should not
 * abort a 10-15h drain — the next run would re-walk hours of already-
 * processed rows (correctness is fine via the WHERE filter, but the LML
 * budget is wasted on duplicate SELECTs). Exhausting the retries propagates
 * the original error to main()'s catch arm, which is the right behavior
 * for a sustained outage.
 */
const loadBatch = async (afterId: number, batchSize: number, cutoffTs: string): Promise<ReenrichRow[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadBatchOnce(afterId, batchSize, cutoffTs);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= LOAD_BATCH_MAX_ATTEMPTS) break;
      const backoff = LOAD_BATCH_BACKOFF_MS[attempt] ?? LOAD_BATCH_BACKOFF_MS[LOAD_BATCH_BACKOFF_MS.length - 1];
      log('warn', 'load_batch_retry', `loadBatch attempt ${attempt + 1} failed; retrying in ${backoff}ms`, {
        attempt: attempt + 1,
        after_id: afterId,
        backoff_ms: backoff,
        error_message: errorMessage(error),
      });
      await sleep(backoff);
    }
  }
  throw lastError;
};

/**
 * Drive a single row through lookup → enrich. Catches BOTH lookup AND
 * enrich (DB) errors so a single bad row cannot abort the run. The row
 * stays `enriched_no_match` so the next coverage expansion revisits it.
 *
 * The earlier shape (only lookup wrapped) violated the docstring invariant
 * — a transient PG error during reenrichRow's UPDATE would bubble through
 * the for-of loop, exit the Sentry span, and trigger main()'s catch arm.
 * Now both arms log+count and return.
 */
const processRow = async (
  row: ReenrichRow,
  deps: { lookup: LookupFn; enrich: EnrichFn }
): Promise<ReenrichOutcome | 'lml_error' | 'db_error'> => {
  let result: LookupResult;
  try {
    result = await deps.lookup(row.artist_name, row.album_title ?? undefined, row.track_title ?? undefined);
  } catch (error) {
    log('warn', 'lml_error', `LML lookup failed for flowsheet.id=${row.id}`, {
      flowsheet_id: row.id,
      error_message: errorMessage(error),
    });
    captureError(error, 'lml_error', {
      flowsheet_id: row.id,
      artist: row.artist_name,
      album: row.album_title ?? null,
      track: row.track_title ?? null,
    });
    return 'lml_error';
  }
  try {
    return await deps.enrich(row, result.response);
  } catch (error) {
    log('warn', 'db_error', `flowsheet UPDATE failed for flowsheet.id=${row.id}`, {
      flowsheet_id: row.id,
      error_message: errorMessage(error),
    });
    captureError(error, 'db_error', {
      flowsheet_id: row.id,
      artist: row.artist_name,
      album: row.album_title ?? null,
      track: row.track_title ?? null,
    });
    return 'db_error';
  }
};

export const runReenrichment = async (opts: {
  lookup: LookupFn;
  enrich: EnrichFn;
  cutoffTs?: string;
  batchSize?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
}): Promise<RunResult> => {
  const cutoffTs = opts.cutoffTs ?? resolveCutoffTs();
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;
  // Hoist deps outside the per-row loop — one object reused for ~12k rows
  // instead of one allocation per row.
  const deps = { lookup: opts.lookup, enrich: opts.enrich };

  log('info', 'started', `${JOB_NAME} starting`, {
    cutoff_ts: cutoffTs,
    batch_size: batchSize,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
  });

  const totals: Totals = {
    scanned: 0,
    match: 0,
    match_raced: 0,
    still_no_match: 0,
    lml_error: 0,
    db_error: 0,
  };
  let lastId = 0;
  let batchIndex = 0;

  while (true) {
    if (stopRequested) {
      log('info', 'stop_requested', `${JOB_NAME} stop requested; exiting between batches`, { last_id: lastId });
      break;
    }

    if (liveActivityLookbackSeconds > 0) {
      while (await probe(liveActivityLookbackSeconds)) {
        if (stopRequested) break;
        log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
          lookback_seconds: liveActivityLookbackSeconds,
          pause_ms: liveActivityPauseMs,
        });
        // No `> 0` gate: sleep(0) still yields the event loop via
        // setTimeout, so the prior "tight spin if pauseMs=0" footgun
        // is closed.
        await sleep(liveActivityPauseMs);
      }
      if (stopRequested) break;
    }

    const rows = await loadBatch(lastId, batchSize, cutoffTs);
    if (rows.length === 0) break;

    batchIndex += 1;
    const batchStart = Date.now();
    const batchTotals = { match: 0, match_raced: 0, still_no_match: 0, lml_error: 0, db_error: 0 };

    for (const row of rows) {
      const outcome = await processRow(row, deps);
      totals.scanned += 1;
      totals[outcome] += 1;
      batchTotals[outcome] += 1;
      if (outcome === 'match_raced') {
        // Surface every raced UPDATE so the runbook's post-run linkage-race
        // audit can correlate (see jobs/flowsheet-reenrichment/README.md).
        // Most race-counted rows are benign (status already flipped); the
        // rare orphan case is a linkage resolver flipping album_id non-null
        // between SELECT and UPDATE, which the audit SELECT detects.
        log('warn', 'possible_linkage_race', `match_raced at flowsheet.id=${row.id}; verify in post-run audit`, {
          flowsheet_id: row.id,
        });
      }
      lastId = row.id;
    }

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      wall_clock_ms: Date.now() - batchStart,
      last_id: lastId,
      scanned: totals.scanned,
      match: batchTotals.match,
      match_raced: batchTotals.match_raced,
      still_no_match: batchTotals.still_no_match,
      lml_error: batchTotals.lml_error,
      db_error: batchTotals.db_error,
      flipped: batchTotals.match,
    });
  }

  const flipped = totals.match;

  // Summary span carrying numeric attributes (BS#1081 typing-trap workaround
  // — set at creation so Sentry indexes as numbers, not strings).
  // No outer span wrapping the multi-hour loop: a 10-15h span would skew
  // Sentry's query-perf dashboards (op='db.query' is meant for sub-second
  // ops), risk per-transaction span-count truncation, and risk the summary
  // child span being orphaned on idle flush.
  Sentry.startSpan(
    {
      name: 'reenrichment.run.summary',
      attributes: {
        'reenrichment.flipped_count': flipped,
        'reenrichment.still_no_match_count': totals.still_no_match,
        'reenrichment.match_raced_count': totals.match_raced,
        'reenrichment.lml_error_count': totals.lml_error,
        'reenrichment.db_error_count': totals.db_error,
        'reenrichment.scanned_count': totals.scanned,
      },
    },
    () => {
      /* attributes set at creation; nothing else to do */
    }
  );

  log('info', 'finished', `${JOB_NAME} done`, {
    // Spread all of `totals` so runbook jq extraction sees match_raced,
    // db_error, and any future counter without a contract change. Sibling
    // cron uses the same pattern.
    ...totals,
    flipped,
  });

  return { totals, flipped };
};
