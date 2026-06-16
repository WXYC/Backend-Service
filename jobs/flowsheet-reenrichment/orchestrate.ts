/**
 * One-shot orchestrator for the flowsheet-reenrichment drain (BS#1433).
 *
 * Iterates flowsheet rows matching:
 *   metadata_status = 'enriched_no_match'
 *   AND album_id IS NULL
 *   AND artist_name IS NOT NULL
 *   AND add_time < $BACKFILL_CUTOFF_TS
 *
 * The cutoff is the LML#583 / PR#584 merge timestamp (2026-06-16T17:53:53Z),
 * which is when the library-miss gap was closed. Rows added after that
 * timestamp already ran through the new path at write time — they are not
 * in this cohort.
 *
 * Per-row (not bulk): this cohort is cascade-bound on cold Discogs lookups
 * (the library-miss-by-definition path LML#583 introduces). Per-row gating
 * shares the LML 50/min Discogs budget gently with real-time traffic; a
 * bulk endpoint would fan multiple cascades into LML's semaphore and replay
 * the BS#994 outage shape.
 *
 * Cooperative pause: same pattern as flowsheet-metadata-backfill (#735).
 * Before each batch, probe flowsheet for activity in the last
 * LIVE_ACTIVITY_LOOKBACK_SECONDS (default 60). If found, defer the batch by
 * LIVE_ACTIVITY_PAUSE_MS (default 30000) and re-probe. Set
 * LIVE_ACTIVITY_LOOKBACK_SECONDS=0 to disable for catch-up runs.
 *
 * The `lookup` and `enrich` functions are injected so tests can drive the
 * orchestration without a live LML or DB. Production wires them to
 * lml-fetch.ts:lookupMetadata and enrich.ts:reenrichRow.
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

export const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'BACKFILL_BATCH_SIZE', BATCH_SIZE);

/**
 * Throws when BACKFILL_CUTOFF_TS is missing — fail-fast so the operator
 * sees a clear message rather than a WHERE that silently matches all rows.
 */
export const resolveCutoffTs = (raw: string | undefined = process.env.BACKFILL_CUTOFF_TS): string => {
  if (!raw)
    throw new Error('BACKFILL_CUTOFF_TS is required; set to the LML#583 merge timestamp (2026-06-16T17:53:53Z).');
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
};

export type RunResult = {
  totals: Totals;
  flipped: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const loadBatch = async (afterId: number, batchSize: number, cutoffTs: string): Promise<ReenrichRow[]> => {
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
 * Drive a single row through lookup → enrich. Returns the outcome or
 * 'lml_error' when LML threw. Errors are logged and consumed so a single
 * bad row cannot abort the run. The row stays enriched_no_match so the
 * next coverage expansion revisits it.
 */
const processRow = async (
  row: ReenrichRow,
  deps: { lookup: LookupFn; enrich: EnrichFn }
): Promise<ReenrichOutcome | 'lml_error'> => {
  let result: LookupResult;
  try {
    result = await deps.lookup(row.artist_name, row.album_title ?? undefined, row.track_title ?? undefined);
  } catch (error) {
    log('warn', 'lml_error', `LML lookup failed for flowsheet.id=${row.id}`, {
      flowsheet_id: row.id,
      error_message: (error as Error).message,
    });
    captureError(error, 'lml_error', { flowsheet_id: row.id, artist: row.artist_name });
    return 'lml_error';
  }
  return deps.enrich(row, result.response);
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

  return Sentry.startSpan(
    {
      name: 'reenrichment.run',
      op: 'db.query',
      attributes: {
        'reenrichment.cutoff_ts': cutoffTs,
        'reenrichment.batch_size': batchSize,
      },
    },
    async () => {
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
      };
      let lastId = 0;
      let batchIndex = 0;

      while (true) {
        if (liveActivityLookbackSeconds > 0) {
          while (await probe(liveActivityLookbackSeconds)) {
            log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
              lookback_seconds: liveActivityLookbackSeconds,
              pause_ms: liveActivityPauseMs,
            });
            if (liveActivityPauseMs > 0) await sleep(liveActivityPauseMs);
          }
        }

        const rows = await loadBatch(lastId, batchSize, cutoffTs);
        if (rows.length === 0) break;

        batchIndex += 1;
        const batchStart = Date.now();
        const batchTotals = { match: 0, match_raced: 0, still_no_match: 0, lml_error: 0 };

        for (const row of rows) {
          const outcome = await processRow(row, { lookup: opts.lookup, enrich: opts.enrich });
          totals.scanned += 1;
          if (outcome === 'lml_error') {
            totals.lml_error += 1;
            batchTotals.lml_error += 1;
          } else {
            totals[outcome] += 1;
            batchTotals[outcome as keyof typeof batchTotals] += 1;
          }
          lastId = row.id;
        }

        const batchFlipped = batchTotals.match;
        log('info', 'batch_done', `batch ${batchIndex} done`, {
          batch_index: batchIndex,
          wall_clock_ms: Date.now() - batchStart,
          scanned: totals.scanned,
          match: batchTotals.match,
          match_raced: batchTotals.match_raced,
          still_no_match: batchTotals.still_no_match,
          lml_error: batchTotals.lml_error,
          flipped: batchFlipped,
        });
      }

      const flipped = totals.match;

      // Child span carrying numeric summary attributes (BS#1081 — set at
      // creation time so Sentry indexes them as numbers, not strings).
      Sentry.startSpan(
        {
          name: 'reenrichment.run.summary',
          attributes: {
            'reenrichment.flipped_count': flipped,
            'reenrichment.still_no_match_count': totals.still_no_match,
          },
        },
        () => {
          /* attributes set at creation; nothing else to do */
        }
      );

      log('info', 'finished', `${JOB_NAME} done`, {
        scanned: totals.scanned,
        flipped,
        still_no_match: totals.still_no_match,
        lml_error: totals.lml_error,
      });

      return { totals, flipped };
    }
  );
};
