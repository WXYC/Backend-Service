/**
 * Backfill orchestrator for #638 (historical metadata drain, A.1.a of #631).
 *
 * Iterates `flowsheet` track rows where `metadata_attempt_at IS NULL`,
 * calls LML for each one, and applies the 10-column UPDATE via
 * `applyEnrichment`. Designed to be resumable and failure-tolerant:
 *
 *   - The WHERE filter is `entry_type='track' AND artist_name IS NOT NULL
 *     AND metadata_attempt_at IS NULL AND add_time < now() - interval '60
 *     seconds'`. The marker (#658) is set on every successful enrichment
 *     attempt — match or no-match — so the same filter cleanly identifies
 *     the un-tried tail at any point in the lifecycle (see #639).
 *   - The 60-second race guard avoids racing the runtime fire-and-forget
 *     UPDATE on rows just inserted via the tubafrenzy webhook.
 *   - Within a single run, batches paginate by `id` (last-id cursor).
 *     Across runs, the WHERE filter is what restarts — the cursor doesn't
 *     need to persist.
 *   - One LML failure is logged, counted as `lml_error`, and the loop
 *     continues. The row stays `metadata_attempt_at IS NULL`, so the
 *     next sweep (recurring drift-repair, #639 Phase 2) retries it.
 *   - Cooperative pause: WXYC has no quiet hours — there is always a DJ in
 *     the booth. Before each batch, the orchestrator probes `flowsheet` for
 *     any track row added in the last `LIVE_ACTIVITY_LOOKBACK_SECONDS`
 *     (default 60). If found, the batch is deferred for
 *     `LIVE_ACTIVITY_PAUSE_MS` (default 30000) and re-probed. The loop
 *     yields whenever a DJ is actively touching the playout — exactly the
 *     window where any incremental p95 hit is most user-visible. The probe
 *     uses migration 0050's partial index on (add_time DESC) WHERE
 *     entry_type='track', so the per-batch cost is one buffer read.
 *     Set `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` to disable for catch-up runs.
 *
 * Concurrent runtime + job stamp race: the runtime path
 * (`enrichment.service.ts`) and this job both stamp on the same column.
 * If a row is mid-flight in the runtime path and the job picks it up,
 * both UPDATEs write identical data with `now()`. No correctness issue —
 * last write wins, data is identical — and `applyEnrichment`'s
 * `WHERE id = $row.id AND metadata_attempt_at IS NULL` predicate makes
 * the second write a no-op once the first lands. The 60-second
 * `add_time` race guard already covers the typical case.
 *
 * The `lookup` and `enrich` functions are injected so tests can drive the
 * orchestration without a live LML or DB. Production wires them to
 * `lml-fetch.ts:lookupMetadata` and `enrich.ts:applyEnrichment`.
 */

import { sql, type SQL } from 'drizzle-orm';
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
import type { EnrichRow, EnrichOutcome } from './enrich.js';
import type { LookupResult } from './lml-fetch.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'flowsheet-metadata-backfill';

export const BATCH_SIZE = 500;

/**
 * Default inter-call delay between LML lookups, in ms. The client→LML rate
 * at 100ms is ~600 req/min — well above Discogs's 50/min ceiling, but LML
 * caches and gates Discogs upstream itself, so most calls are cache hits
 * and the orchestrator's job is to keep one in-flight at a time, not to
 * directly enforce the Discogs budget. Raise via `BACKFILL_THROTTLE_MS`
 * if a future LML configuration tightens its own client-side cap. Tests
 * override to 0.
 */
export const THROTTLE_MS = 100;

/**
 * Schema-qualified table reference, honoring `WXYC_SCHEMA_NAME` so parallel
 * Jest workers (which override the env var) and any future integration test
 * harness target the right schema. The default `wxyc_schema` matches
 * production. Sanitised against `"` to keep the SQL well-formed.
 */
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);

/**
 * Resolve `BACKFILL_BATCH_SIZE` from the environment, falling back to
 * `BATCH_SIZE`. Mirrors `flowsheet-dj-name-backfill/job.ts:resolveBatchSize`
 * — operators tune via `docker run -e BACKFILL_BATCH_SIZE=...` when the
 * prod instance has headroom.
 *
 * Exported so unit tests can drive it without mucking with process.env.
 */
export const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'BACKFILL_BATCH_SIZE', BATCH_SIZE);

/**
 * Resolve `BACKFILL_THROTTLE_MS` from the environment, falling back to
 * `THROTTLE_MS`. Operators tighten this if a future LML configuration
 * tightens its own client-side cap, or set 0 in pilot/CI runs to remove
 * the inter-row sleep.
 *
 * Exported so unit tests can drive it without mucking with process.env.
 */
export const resolveThrottleMs = (raw: string | undefined = process.env.BACKFILL_THROTTLE_MS): number =>
  requireNonNegativeInt(raw, 'BACKFILL_THROTTLE_MS', THROTTLE_MS);

/**
 * Throws on misconfig — this is a cron-driven job; loud failure is
 * preferred so an operator notices. `0` disables the probe (catch-up runs).
 */
export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable the cooperative pause.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_PAUSE_MS', LIVE_ACTIVITY_PAUSE_MS_DEFAULT, { unit: 'ms' });

/**
 * Resolve PARTITION_INDEX / PARTITION_COUNT env vars into a SQL fragment that
 * picks every Nth row by id-modulo. Mirrors `library-canonical-entity-backfill`'s
 * partition resolver — the N-container deploy pattern is:
 *
 *   PARTITION_COUNT=4 PARTITION_INDEX=0 docker run ...
 *   PARTITION_COUNT=4 PARTITION_INDEX=1 docker run ...
 *   ...
 *
 * Each container processes a disjoint subset and they finish in roughly the
 * same wall time. The default (count=1, index=0) is a no-op pass-through so
 * single-container runs are unaffected.
 *
 * Exported so unit tests can drive it without mucking with process.env.
 */
export const resolvePartitionFilter = (
  rawIndex: string | undefined = process.env.PARTITION_INDEX,
  rawCount: string | undefined = process.env.PARTITION_COUNT,
  columnSql: SQL = sql`"id"`
): { sqlFragment: SQL | null; description: string } => {
  const count = rawCount === undefined ? 1 : Number(rawCount);
  const index = rawIndex === undefined ? 0 : Number(rawIndex);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid PARTITION_COUNT=${JSON.stringify(rawCount)}; must be a positive integer.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `Invalid PARTITION_INDEX=${JSON.stringify(rawIndex)}; must be 0 <= index < PARTITION_COUNT (${count}).`
    );
  }
  if (count === 1) {
    return { sqlFragment: null, description: 'partition=none' };
  }
  return {
    sqlFragment: sql`AND (${columnSql} % ${count}) = ${index}`,
    description: `partition=${index}/${count}`,
  };
};

/**
 * Lookup contract: returns the LML response (or its cached substitute)
 * plus a `cacheHit` flag the orchestrator uses to skip the per-row LML
 * throttle on hits. Pre-cache the return was just `LookupResponse`;
 * the wrapper-shape change is required so the orchestrator can recover
 * the wall-clock budget the throttle would otherwise spend waiting after
 * a no-op cache return.
 */
export type LookupFn = (artist: string, album?: string, track?: string) => Promise<LookupResult>;

export type EnrichFn = (row: EnrichRow, response: LookupResponse) => Promise<EnrichOutcome>;

/**
 * Read the current (artist, album) lookup-dedup cache state. Wired by
 * `job.ts` to `getLookupCache().stats()`; tests inject a stub. Returns
 * undefined when the orchestrator is driven without a cache (synthetic
 * tests that don't care about dedup observability).
 *
 * `overwrites` flags the race-to-store case (two concurrent callers
 * both went to LML and both wrote); the sequential orchestrator never
 * triggers this, so any non-zero value in the log signals a regression.
 *
 * See plans/flowsheet-backfill-lookup-dedup.md and `lookup-cache.ts`.
 */
export type CacheStatsFn = () => { size: number; hits: number; misses: number; overwrites: number };

export type Totals = {
  scanned: number;
  enriched_match: number;
  enriched_match_raced: number;
  enriched_no_match: number;
  enriched_no_match_raced: number;
  lml_error: number;
};

export type ProcessOutcome = EnrichOutcome | 'lml_error';

/**
 * Outcome plus cache provenance, so the per-row loop can skip the LML
 * throttle on hits. `cacheHit` is undefined for the `lml_error` branch
 * (we never called the cache successfully) and false for `enriched_*`
 * outcomes that went to the upstream.
 */
export type ProcessResult = { outcome: ProcessOutcome; cacheHit: boolean };

export type RunResult = {
  totals: Totals;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive a single row through lookup → enrich. The result is the outcome
 * status (or 'lml_error' when LML threw). Errors are logged and consumed;
 * they do not bubble up so a single bad row cannot abort the run. The row
 * stays `metadata_attempt_at IS NULL` so the next sweep retries it.
 */
export const processRow = async (
  row: EnrichRow,
  deps: { lookup: LookupFn; enrich: EnrichFn }
): Promise<ProcessResult> => {
  const artist = row.artist_name;
  const album = row.album_title ?? undefined;
  const track = row.track_title ?? undefined;

  let result: LookupResult;
  try {
    result = await deps.lookup(artist, album, track);
  } catch (error) {
    log('warn', 'lml_error', `LML lookup failed for flowsheet.id=${row.id}`, {
      flowsheet_id: row.id,
      error_message: (error as Error).message,
    });
    captureError(error, 'lml_error', { flowsheet_id: row.id, artist, album, track });
    return { outcome: 'lml_error', cacheHit: false };
  }

  const outcome = await deps.enrich(row, result.response);
  return { outcome, cacheHit: result.cacheHit };
};

/**
 * Read the next batch of unprocessed flowsheet rows.
 *
 * The id-cursor predicate keeps the SELECT bounded as the run progresses.
 * Combined with the partial index from #659
 * (`flowsheet_metadata_attempt_pending_idx ON (id) WHERE entry_type='track'
 * AND artist_name IS NOT NULL AND metadata_attempt_at IS NULL`), the
 * planner does an Index Scan with `Index Cond: (id > $afterId)` and the
 * partial WHERE is implicit in the index choice. Verified pre-#659 merge
 * via EXPLAIN (see PR #660).
 */
const loadBatch = async (afterId: number, batchSize: number, partitionFilter: SQL | null): Promise<EnrichRow[]> => {
  const partitionClause = partitionFilter ?? sql``;
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title",
      "track_title",
      "album_id"
    FROM ${FLOWSHEET_TABLE}
    WHERE "entry_type" = 'track'
      AND "artist_name" IS NOT NULL
      AND "metadata_attempt_at" IS NULL
      AND "add_time" < now() - interval '60 seconds'
      AND "id" > ${afterId}
      ${partitionClause}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as EnrichRow[];
  return rows ?? [];
};

const formatTotals = (totals: Totals): string =>
  `scanned=${totals.scanned} enriched_match=${totals.enriched_match} ` +
  `enriched_match_raced=${totals.enriched_match_raced} ` +
  `enriched_no_match=${totals.enriched_no_match} ` +
  `enriched_no_match_raced=${totals.enriched_no_match_raced} lml_error=${totals.lml_error}`;

export const runBackfill = async (opts: {
  lookup: LookupFn;
  enrich: EnrichFn;
  batchSize?: number;
  throttleMs?: number;
  partition?: { sqlFragment: SQL | null; description: string };
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  cacheStats?: CacheStatsFn;
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const throttleMs = opts.throttleMs ?? resolveThrottleMs();
  const partition = opts.partition ?? resolvePartitionFilter();
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: batchSize,
    throttle_ms: throttleMs,
    partition: partition.description,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
  });

  const totals: Totals = {
    scanned: 0,
    enriched_match: 0,
    enriched_match_raced: 0,
    enriched_no_match: 0,
    enriched_no_match_raced: 0,
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

    const rows = await loadBatch(lastId, batchSize, partition.sqlFragment);
    if (rows.length === 0) break;

    batchIndex += 1;
    for (const row of rows) {
      const { outcome, cacheHit } = await processRow(row, { lookup: opts.lookup, enrich: opts.enrich });
      totals.scanned += 1;
      totals[outcome] += 1;
      lastId = row.id;
      // Throttle exists to pace LML calls (BACKFILL_THROTTLE_MS docstring
      // above). A cache hit makes no LML call, so sleeping after one is
      // wall-clock waste — at the documented 42% hit rate over ~628k
      // rows that's ~7.3h per run recovered.
      if (throttleMs > 0 && !cacheHit) await sleep(throttleMs);
    }

    const cacheFields = readCacheFields(opts.cacheStats);

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      last_id: lastId,
      ...totals,
      ...cacheFields,
    });
  }

  const finalCacheFields = readCacheFields(opts.cacheStats);
  log('info', 'finished', `${JOB_NAME} done. ${formatTotals(totals)}`, { ...totals, ...finalCacheFields });
  return { totals };
};

/**
 * Read the optional cache-stats injection and project it into flat log
 * fields. Wrapped in try/catch so an observability throw can never abort
 * the drain — the per-row work is already committed by the time
 * `batch_done` logs, and a degraded log line is strictly better than an
 * `exit 1` that wipes a successful batch from the deploy story.
 */
const readCacheFields = (
  cacheStats: CacheStatsFn | undefined
):
  | { cache_hits: number; cache_misses: number; cache_size: number; cache_overwrites: number }
  | { cache_stats_error: string }
  | Record<string, never> => {
  if (!cacheStats) return {};
  try {
    const { size, hits, misses, overwrites } = cacheStats();
    return { cache_hits: hits, cache_misses: misses, cache_size: size, cache_overwrites: overwrites };
  } catch (error) {
    // Defend against non-Error throws (`throw 'string'`, `throw { code: x }`) —
    // `(err as Error).message` would emit undefined and the JSON logger
    // would drop the key, leaving operators with no signal at all.
    const message = error instanceof Error ? error.message : String(error);
    return { cache_stats_error: message };
  }
};
