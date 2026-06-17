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
 * Linkage-race note (review-round-2/3): a parallel linkage resolver can
 * flip album_id non-null between the orchestrator's SELECT and
 * reenrichRow's UPDATE. The UPDATE's `album_id IS NULL` guard then matches
 * 0 rows (counted as `match_raced`) and the row is left in
 * `enriched_no_match` with a linked album_id. Since no auto path revisits
 * `enriched_no_match`, the README documents a post-run audit SQL that
 * catches these and a working rescue UPDATE that re-arms them for the
 * nightly backfill cron. The run logs the *count* and the first few IDs
 * once at the end (review-round-3 — per-row warn was excessive).
 *
 * SIGTERM handling: stopRequested is checked between batches AND between
 * rows AND inside the live-activity sleep AND inside the loadBatch retry
 * sleeps, so docker stop responds within ~1 row latency. The early-break
 * log uses `step: 'stopped'`, not `'finished'`, so the runbook jq filter
 * doesn't mis-report partial totals as a completed run.
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
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'flowsheet-reenrichment';

export const BATCH_SIZE = 100;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);

/**
 * Retry budget for loadBatch's SELECT. A transient RDS failover or network
 * blip should not abort a 10-15h drain. Backoff array length matches
 * MAX_ATTEMPTS so every retry has a defined wait; total worst-case wait
 * = sum(LOAD_BATCH_BACKOFF_MS[0..MAX_ATTEMPTS-2]) (the final attempt's
 * sleep is never used because we throw on failure).
 */
const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000];

/**
 * Strict-ish ISO 8601 check: YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]. Catches
 * Date.parse-passes-but-PG-rejects inputs like '2026-6-16', '2026/06/16',
 * '2026', '6/16/2026'. Also enforces Date.parse roundtrip equality so
 * normalized out-of-range days (e.g. '2026-02-30' → '2026-03-02') are
 * rejected even though Date.parse accepts them.
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'BACKFILL_BATCH_SIZE', BATCH_SIZE);

/**
 * Throws when BACKFILL_CUTOFF_TS is missing, syntactically invalid (not
 * strict ISO 8601), has an out-of-range calendar day/hour/etc, or is in
 * the future. Fail-fast so the operator sees a clear message rather than
 * a Postgres ::timestamptz cast stack trace from the first loadBatch.
 *
 * Calendar validation is done on the raw fields (irrespective of TZ),
 * which is what Date.parse silently normalizes — e.g. '2026-02-30' →
 * '2026-03-02' would otherwise pass JS validation and shift the cohort.
 */
export const resolveCutoffTs = (raw: string | undefined = process.env.BACKFILL_CUTOFF_TS): string => {
  if (!raw) {
    throw new Error('BACKFILL_CUTOFF_TS is required; set to the LML#583 merge timestamp (2026-06-16T17:53:53Z).');
  }
  if (!ISO_8601_RE.test(raw)) {
    throw new Error(
      `BACKFILL_CUTOFF_TS=${JSON.stringify(raw)} is not strict ISO 8601 (e.g. 2026-06-16T17:53:53Z or 2026-06-16T10:53:53-07:00).`
    );
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const hour = Number(raw.slice(11, 13));
  const minute = Number(raw.slice(14, 16));
  const second = Number(raw.slice(17, 19));
  // Calendar bounds — month, hour, minute, second. Days-in-month uses Date
  // (day 0 of next month is the last day of this month).
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth || hour > 23 || minute > 59 || second > 59) {
    throw new Error(
      `BACKFILL_CUTOFF_TS=${JSON.stringify(raw)} has an out-of-range field (calendar / 24h validation failed).`
    );
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`BACKFILL_CUTOFF_TS=${JSON.stringify(raw)} is not a parseable timestamp.`);
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
  stopped: boolean;
};

/**
 * Cooperative cancellation flag for graceful shutdown on SIGTERM. The
 * runReenrichment loop checks this between batches, between rows, in the
 * live-activity sleep, and in the loadBatch retry sleeps.
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

/**
 * Stop-aware sleep: returns early if stopRequested becomes true during the
 * sleep window. Polls every min(500ms, remaining) so a SIGTERM during a
 * 30s cooperative-pause doesn't keep the operator waiting most of those
 * 30s before the run honors the stop.
 */
const stopAwareSleep = async (ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopRequested) return;
    const remaining = deadline - Date.now();
    const tick = Math.min(500, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, tick));
  }
};

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
 * Sentinel for the rare "stop arrived during a backoff sleep" path. The
 * outer loop treats this as a clean stop-break (NOT a failure), so the
 * run still emits the `stopped` summary log + summary span instead of
 * `failed` with no totals.
 */
class StopRequestedDuringRetry extends Error {
  constructor() {
    super('stop requested during loadBatch retry backoff');
    this.name = 'StopRequestedDuringRetry';
  }
}

/**
 * loadBatch with transient-error retry. Honors stopRequested so shutdown
 * isn't blocked by retry backoffs. Exhausting retries throws the most
 * recent error. Stop-during-backoff throws a sentinel the outer loop
 * recognizes as a stop (not a failure), so the run still emits the
 * stopped summary instead of the failed-with-no-totals shape.
 */
const loadBatch = async (afterId: number, batchSize: number, cutoffTs: string): Promise<ReenrichRow[]> => {
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadBatchOnce(afterId, batchSize, cutoffTs);
    } catch (error) {
      const isLast = attempt + 1 >= LOAD_BATCH_MAX_ATTEMPTS;
      if (stopRequested) throw new StopRequestedDuringRetry();
      if (isLast) throw error;
      const backoff = LOAD_BATCH_BACKOFF_MS[attempt] ?? LOAD_BATCH_BACKOFF_MS[LOAD_BATCH_BACKOFF_MS.length - 1];
      log('warn', 'load_batch_retry', `loadBatch attempt ${attempt + 1} failed; retrying in ${backoff}ms`, {
        attempt: attempt + 1,
        after_id: afterId,
        backoff_ms: backoff,
        error_message: errorMessage(error),
      });
      await stopAwareSleep(backoff);
      if (stopRequested) throw new StopRequestedDuringRetry();
    }
  }
  // Unreachable: the loop above either returns or throws.
  throw new Error('loadBatch: unreachable retry-exhaustion path');
};

/**
 * Drive a single row through lookup → enrich. Catches BOTH lookup AND
 * enrich (DB) errors so a single bad row cannot abort the run.
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

// Cap on how many raced flowsheet IDs to include in the final summary log
// — keeps the log line bounded if a parallel linkage resolver flips a
// large number of rows. Operators with > MATCH_RACED_SAMPLE rows should
// run the README's audit SQL to enumerate them all.
const MATCH_RACED_SAMPLE = 20;

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
  // Hoist deps outside the per-row loop — one object reused for ~12k rows.
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
  const matchRacedIds: number[] = [];
  let matchRacedTruncatedCount = 0;
  let lastId = 0;
  let batchIndex = 0;
  let stopped = false;
  let failed: { error: unknown } | null = null;

  try {
    outer: while (true) {
      if (stopRequested) {
        stopped = true;
        break;
      }

      if (liveActivityLookbackSeconds > 0) {
        // Wrap the probe SELECT in try/catch so a transient RDS error doesn't
        // abort the whole run with no summary — same posture as loadBatch's
        // retry. We don't bother retrying the probe (it's a single buffer
        // read against a partial index); on failure we log and proceed as
        // if no activity, deferring to the next batch.
        let probeActive = false;
        try {
          probeActive = await probe(liveActivityLookbackSeconds);
        } catch (error) {
          log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
            error_message: errorMessage(error),
          });
          captureError(error, 'probe_error');
        }
        while (probeActive) {
          if (stopRequested) {
            stopped = true;
            break outer;
          }
          log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
            lookback_seconds: liveActivityLookbackSeconds,
            pause_ms: liveActivityPauseMs,
          });
          await stopAwareSleep(liveActivityPauseMs);
          try {
            probeActive = await probe(liveActivityLookbackSeconds);
          } catch (error) {
            log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
              error_message: errorMessage(error),
            });
            captureError(error, 'probe_error');
            probeActive = false;
          }
        }
        if (stopRequested) {
          stopped = true;
          break;
        }
      }

      let rows: ReenrichRow[];
      try {
        rows = await loadBatch(lastId, batchSize, cutoffTs);
      } catch (error) {
        if (error instanceof StopRequestedDuringRetry) {
          // Treat as a clean stop — summary span + structured log still emit.
          stopped = true;
          break;
        }
        // Sustained DB outage exhausted the retry budget. Capture so the
        // finally arm still emits the summary span + log with last_id,
        // enabling resume-from-last_id from the structured logs.
        failed = { error };
        break;
      }
      if (rows.length === 0) break;

      batchIndex += 1;
      const batchStart = Date.now();
      // Snapshot totals before the batch so per-batch counters can be
      // derived without a parallel batchTotals object (round 3 cleanup).
      const before = { ...totals };

      for (const row of rows) {
        const outcome = await processRow(row, deps);
        totals.scanned += 1;
        totals[outcome] += 1;
        if (outcome === 'match_raced') {
          if (matchRacedIds.length < MATCH_RACED_SAMPLE) matchRacedIds.push(row.id);
          else matchRacedTruncatedCount += 1;
        }
        lastId = row.id;
        // Stop check between rows (round 3): with batch_size=100 and ~3s/row
        // a batch can take ~5 min — far beyond docker's 10s default grace.
        // Per-row check keeps the README's "finishes its in-flight row" claim
        // honest.
        if (stopRequested) {
          stopped = true;
          break;
        }
      }

      log('info', 'batch_done', `batch ${batchIndex} done`, {
        batch_index: batchIndex,
        wall_clock_ms: Date.now() - batchStart,
        last_id: lastId,
        // Per-batch deltas (round 3): derived from the pre-batch snapshot so
        // there's no parallel counter to keep in sync.
        scanned: totals.scanned - before.scanned,
        match: totals.match - before.match,
        match_raced: totals.match_raced - before.match_raced,
        still_no_match: totals.still_no_match - before.still_no_match,
        lml_error: totals.lml_error - before.lml_error,
        db_error: totals.db_error - before.db_error,
        flipped: totals.match - before.match,
        // Cumulative scanned for progress monitoring.
        total_scanned: totals.scanned,
      });

      if (stopped) break;
    }
  } finally {
    const flipped = totals.match;

    // Summary span carrying numeric attributes (BS#1081 typing-trap workaround).
    // Always emitted — even on stop/fail — so partial-run telemetry is
    // available in Sentry trace explorer.
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
          'reenrichment.last_id': lastId,
          'reenrichment.stopped': stopped,
          'reenrichment.failed': failed !== null,
        },
      },
      () => {
        /* attributes set at creation */
      }
    );

    if (totals.match_raced > 0) {
      log(
        'warn',
        'match_raced_summary',
        `${totals.match_raced} rows raced; run README post-run audit SQL to enumerate`,
        {
          match_raced_count: totals.match_raced,
          sample_ids: matchRacedIds,
          truncated_count: matchRacedTruncatedCount,
        }
      );
    }

    // Distinct steps so the runbook's jq filter can differentiate:
    //   - 'finished' — drain ran to completion (empty batch)
    //   - 'stopped'  — SIGTERM caused a clean early break
    //   - 'failed'   — uncaught exception; the structured log still
    //                  carries last_id so the operator can resume.
    const step = failed ? 'failed' : stopped ? 'stopped' : 'finished';
    const level = failed ? 'error' : 'info';
    log(level, step, `${JOB_NAME} ${step}`, {
      ...totals,
      flipped,
      last_id: lastId,
      stopped,
      failed: failed !== null,
      ...(failed ? { error_message: errorMessage(failed.error) } : {}),
    });
    if (failed) {
      captureError(failed.error, 'failed', { last_id: lastId, scanned: totals.scanned, flipped });
    }
  }
  const flipped = totals.match;
  return { totals, flipped, stopped };
};
