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
 *   - Within a single run, row order comes from a play-priority work-list
 *     materialized once at run start (BS#1591, `worklist.ts`): pending row
 *     ids ordered by per-artist total plays descending, with non-library
 *     artists below a configurable play-floor excluded at query time. The
 *     high-value cache-friendly head drains first; the uncacheable one-off
 *     tail stops consuming Discogs fan-out (the 2026-07-10 LML 502 flood).
 *     A monotonic array cursor drains the list — it advances
 *     unconditionally, so a failing row can never be re-selected within a
 *     run (the BS#1011 wedge-proof property, preserved under value order
 *     where a naive head-of-cohort re-SELECT would jam on the highest-play
 *     failing row). Across runs, the WHERE filter is what restarts — the
 *     work-list doesn't need to persist. Rows inserted mid-run are not in
 *     the list and simply wait for the next run (the live enrichment-worker
 *     owns new rows anyway).
 *   - A per-row failure — an LML throw (`lml_error`) or a DB-write throw
 *     (`enrich_error`, e.g. a mojibake title overflowing a varchar column,
 *     BS#1011) — is logged, counted, and the loop continues. The row stays
 *     `metadata_attempt_at IS NULL`, so the next sweep (recurring
 *     drift-repair, #639 Phase 2) retries it; the in-run cursor still
 *     advances, so one bad row can never wedge the drain.
 *   - Cooperative pause: WXYC has no quiet hours — there is always a DJ in
 *     the booth. Before the work-list build and before each batch, the
 *     orchestrator probes `flowsheet` for
 *     any track row added in the last `LIVE_ACTIVITY_LOOKBACK_SECONDS`
 *     (default 60). If found, the batch is deferred for
 *     `LIVE_ACTIVITY_PAUSE_MS` (default 30000) and re-probed. The loop
 *     yields whenever a DJ is actively touching the playout — exactly the
 *     window where any incremental p95 hit is most user-visible. The probe
 *     uses migration 0050's partial index on (add_time DESC) WHERE
 *     entry_type='track', so the per-batch cost is one buffer read.
 *     Set `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` to disable for catch-up runs.
 *
 * Concurrent CDC-worker overlap: the live enrichment worker
 * (`apps/enrichment-worker`) finalizes rows via `metadata_status` and — by
 * BS#891 design — never writes `metadata_attempt_at`, so worker-enriched
 * rows stay inside this job's marker-based pending cohort. (The old
 * marker-stamping runtime fire-and-forget path was removed in Epic C C5 /
 * #894; the worker is the sole live enricher.) The batch loader therefore
 * selects `metadata_status` and the loop partitions on it: rows the worker
 * already drove to a terminal status get a marker-only reconcile stamp (no
 * LML call — the enrichment already happened; the stamp just closes the
 * marker state machine so the cohort converges), rows the worker has
 * in-flight (`enriching`) are left untouched for the next run, and only
 * still-`pending` rows spend a lookup. The residual race window — a row
 * claimed by the worker between its slice's SELECT and its turn in the
 * per-row loop — is seconds wide and benign: both writers persist
 * near-identical top-match LML payloads through orthogonal guards, and the
 * job's marker stamp removes the row from every future work-list. The
 * 60-second `add_time` race guard covers the just-inserted case.
 *
 * The `lookup` and `enrich` functions are injected so tests can drive the
 * orchestration without a live LML or DB. Production wires them to
 * `lml-fetch.ts:lookupMetadata` and `enrich.ts:applyEnrichment`.
 */

import * as Sentry from '@sentry/node';
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
import { stampDeadLetter as defaultStampDeadLetter } from './enrich.js';
import type { LookupResult } from './lml-fetch.js';
import { captureError, log } from './logger.js';
import {
  buildWorkList as defaultBuildWorkList,
  FLOWSHEET_TABLE,
  unwrapRows,
  type BuildWorkListFn,
} from './worklist.js';

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
 * Default non-library play-floor (BS#1591): free-text rows whose artist is
 * not in the library and has fewer than this many total plays are excluded
 * from the drain at query time. The value 5 was decided in the 2026-07-13
 * triage — enrich repeat freeform artists, deprioritize the deep
 * uncacheable one-off tail.
 */
export const PLAY_FLOOR_DEFAULT = 5;

/**
 * Default recency exemption window in days (BS#1591 decision 5): rows
 * younger than this are always eligible regardless of the floor, so the
 * BS#895 recovery-sweep role can't be poisoned by the floor stranding
 * consumer-missed rows of below-floor artists.
 *
 * 30, not 7: the window must outlive a full drain pass, because a
 * consumer-missed below-floor row sorts near the plays-DESC TAIL of the
 * work-list — during the initial catch-up (a ~176k-row eligible list
 * drained at LML pace over multiple nights) a 7-day window could expire
 * before any run reached the tail, permanently stranding the row in the
 * below-floor residual, which is the exact outcome decision 5 exists to
 * prevent. The wider window is near-free: rows younger than the window are
 * almost all worker-enriched already (reconciled by the status partition
 * without an LML call), so its marginal cost is only the genuinely
 * consumer-missed rows — the ones we want swept.
 */
export const FLOOR_RECENCY_DAYS_DEFAULT = 30;

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
 * Resolve `BACKFILL_NONLIBRARY_PLAY_FLOOR` (BS#1591). `0` disables the
 * floor entirely; misconfiguration throws at startup — this is a
 * cron-driven job, loud failure is preferred.
 */
export const resolvePlayFloor = (raw: string | undefined = process.env.BACKFILL_NONLIBRARY_PLAY_FLOOR): number =>
  requireNonNegativeInt(raw, 'BACKFILL_NONLIBRARY_PLAY_FLOOR', PLAY_FLOOR_DEFAULT, {
    unit: 'plays',
    note: 'Use 0 to disable the non-library play-floor.',
  });

/**
 * Resolve `BACKFILL_FLOOR_RECENCY_DAYS` (BS#1591 decision 5). `0` disables
 * the recency exemption — only sensible while this cron remains a pure
 * historical drain; keep it non-zero once BS#895 lands.
 */
export const resolveFloorRecencyDays = (raw: string | undefined = process.env.BACKFILL_FLOOR_RECENCY_DAYS): number =>
  requireNonNegativeInt(raw, 'BACKFILL_FLOOR_RECENCY_DAYS', FLOOR_RECENCY_DAYS_DEFAULT, {
    unit: 'days',
    note: 'Use 0 to disable the recency exemption from the play-floor.',
  });

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
 * BS#1591 caveat: the partition fragment composes into the pending
 * predicate only — the work-list build's `plays` aggregate is deliberately
 * partition-BLIND (play counts must be global totals), so N containers each
 * re-run the full ~30s aggregate plus the pending COUNT at the same
 * instant. Combined throughput stays pinned at LML's upstream gate anyway;
 * multi-partition mode was evaluated and rejected for this job (#641 — see
 * job.ts), so treat this recipe as documentation of the dormant mechanism,
 * not an operational lever.
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
 * Marker-only dead-letter stamp injected into `processRow` (BS#1562). Wired
 * by production to `enrich.ts:stampDeadLetter`; tests inject a mock. Always
 * resolves — the helper swallows its own errors (best-effort).
 */
export type StampDeadLetterFn = (rowId: number) => Promise<void>;

/**
 * Extract a postgres-js SQLSTATE from a caught enrich error, robust to the
 * drizzle wrapper shape. drizzle re-throws the driver error; postgres-js
 * exposes the 5-char SQLSTATE as `.code`, typically surfaced on the wrapper's
 * `.cause`. Prefer `cause.code`, fall back to a top-level `.code`. Returns
 * undefined when no *string* code can be read — the caller treats that as
 * transient (retryable), failing safe toward retry rather than silent
 * give-up.
 */
const extractSqlState = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const code = causeCode ?? (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Classify an enrich failure as *permanent* (re-running the same row will
 * always reproduce it) vs transient. Permanent = SQLSTATE class `22` (data
 * exception — includes `22001` string_data_right_truncation, the mojibake
 * varchar-overflow poison rows from BS#1560) OR class `23`
 * (integrity_constraint_violation).
 *
 * Everything else — deadlock (`40P01`), serialization failure (`40001`),
 * connection errors, or an SQLSTATE we can't determine — is transient, so the
 * row stays `metadata_attempt_at IS NULL` and the next sweep retries it. Fail
 * safe toward retry, never toward silently dead-lettering a row a retry could
 * have enriched.
 */
export const isPermanentEnrichError = (error: unknown): boolean => {
  const sqlState = extractSqlState(error);
  if (!sqlState) return false;
  const cls = sqlState.slice(0, 2);
  return cls === '22' || cls === '23';
};

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
  // Enrich (DB-write) failure on a single row. Kept distinct from `lml_error`
  // (upstream LML throw) so a run's log line separates "LML couldn't answer"
  // from "we couldn't persist" — a spike in this bucket points at data, not
  // the upstream (BS#1011: mojibake titles overflowing varchar(512) columns).
  enrich_error: number;
  // BS#1591: pending rows deliberately excluded by the non-library
  // play-floor (constant per run, from the work-list build). The pending
  // cohort no longer drains to literal 0 — the retire criterion is
  // "pending ≈ below_floor_skipped" (approximate: the subtraction spans two
  // statement snapshots and can be race-skewed by a few rows; see
  // worklist.ts) — so dashboards need this to subtract.
  below_floor_skipped: number;
  // BS#1591: work-list ids that VANISHED before their batch load — the row
  // was hard-deleted mid-run (flowsheet deleteEntry), or its marker was
  // stamped by an out-of-band writer. NOT worker overlap: the CDC worker
  // never writes `metadata_attempt_at`, so worker-enriched rows cannot trip
  // the marker re-check — they surface as `worker_reconciled` instead.
  stale_skipped: number;
  // BS#1591 review follow-up: work-list rows the CDC worker had already
  // driven to a terminal `metadata_status` (enriched_match /
  // enriched_no_match / failed_no_retry) by batch-load time. The enrichment
  // already happened (or terminally failed) on the worker's side, so no LML
  // call is spent — the job stamps `metadata_attempt_at` only, closing the
  // marker state machine so the pending cohort converges. This bucket IS
  // the worker-overlap signal.
  worker_reconciled: number;
  // BS#1591 review follow-up: work-list rows the worker had claimed
  // (`metadata_status = 'enriching'`) — or carrying an unrecognized future
  // status — at batch-load time. Left completely untouched (no LML, no
  // stamp): a live claim finalizes and reconciles next run; a wedged claim
  // is the C6 sweep's job to requeue, not ours to race.
  worker_inflight_skipped: number;
};

export type ProcessOutcome = EnrichOutcome | 'lml_error' | 'enrich_error';

/**
 * Outcome plus cache provenance, so the per-row loop can skip the LML
 * throttle on hits. `cacheHit` is false for the `lml_error` branch (we
 * threw before the cache had a chance to record a hit, so the throttle
 * still runs to space the next LML attempt) and false for `enriched_*`
 * outcomes that came from a cache miss (lookup-cache.ts:set was called).
 * True only when lookup-cache.ts:get returned a stored response.
 */
export type ProcessResult = { outcome: ProcessOutcome; cacheHit: boolean };

export type RunResult = {
  totals: Totals;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive a single row through lookup → enrich. The result is the outcome
 * status: 'lml_error' when the LML lookup threw, 'enrich_error' when the
 * per-row DB write threw. BOTH failures are logged, captured, and consumed
 * — neither bubbles up, so a single bad row cannot abort the run. The row
 * stays `metadata_attempt_at IS NULL` so the next sweep retries it.
 *
 * The enrich catch is load-bearing, not defensive boilerplate: without it a
 * single row whose synthesized search URL overflows a varchar(512) column
 * (mojibake titles from the legacy latin1→UTF-8 ETL) throws mid-batch, the
 * throw propagates to `main` → exit 1, and because the failed UPDATE never
 * stamps `metadata_attempt_at`, the id-cursor re-selects that same row as the
 * smallest pending id on the next run and crashes again — a permanent stall
 * (BS#1011). Isolating the throw here lets the cursor advance past it.
 *
 * Dead-lettering (BS#1562): isolating the throw kept the cursor moving but
 * still left the poison row `metadata_attempt_at IS NULL`, so it was
 * re-attempted (and re-failed, and re-logged) every nightly run forever — the
 * pending cohort never reached literal 0, breaking BS#1011's "cohort == 0"
 * retire criterion. When the SQLSTATE marks the failure *permanent* (data
 * exception / integrity violation — `isPermanentEnrichError`), we stamp the
 * marker via `stampDeadLetter` so the row leaves the pending cohort. Genuinely
 * transient failures (deadlock, serialization, connection drop, or an
 * unreadable code) are left unstamped and retryable, exactly as before.
 */
export const processRow = async (
  row: EnrichRow,
  deps: { lookup: LookupFn; enrich: EnrichFn; stampDeadLetter?: StampDeadLetterFn }
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

  try {
    const outcome = await deps.enrich(row, result.response);
    return { outcome, cacheHit: result.cacheHit };
  } catch (error) {
    // Classify the failure by SQLSTATE. A permanent error (data exception /
    // integrity violation) will reproduce every run, so dead-letter the row —
    // stamp the marker so it leaves the `metadata_attempt_at IS NULL` cohort.
    // Transient errors stay unstamped and retryable.
    const deadLettered = isPermanentEnrichError(error);
    // Defend against non-Error throws (`throw 'string'`, `throw { code: x }`) —
    // `(error as Error).message` would emit undefined and the JSON logger would
    // drop the key, matching `readCacheFields`'s guard below.
    const message = error instanceof Error ? error.message : String(error);
    log('warn', 'enrich_error', `enrich failed for flowsheet.id=${row.id}`, {
      flowsheet_id: row.id,
      error_message: message,
      // Distinguish "dead-lettered (permanent → stamped, left the cohort)"
      // from "left retryable (transient → stays pending)" without a new
      // totals bucket. A spike in dead_lettered=true points at data corruption.
      dead_lettered: deadLettered,
    });
    captureError(error, 'enrich_error', { flowsheet_id: row.id, artist, album, track, dead_lettered: deadLettered });
    if (deadLettered) {
      // Best-effort — `stampDeadLetter` swallows its own errors, but wrap the
      // call anyway so an injected/alternate stamp that DOES throw can never
      // re-wedge the drain (BS#1561's failure mode). The cursor must advance
      // even if the marker never lands; the row just falls to a future sweep.
      const stamp = deps.stampDeadLetter ?? defaultStampDeadLetter;
      try {
        await stamp(row.id);
      } catch (stampError) {
        const stampMessage = stampError instanceof Error ? stampError.message : String(stampError);
        log('warn', 'dead_letter_stamp_error', `dead-letter stamp failed for flowsheet.id=${row.id}`, {
          flowsheet_id: row.id,
          error_message: stampMessage,
        });
        captureError(stampError, 'dead_letter_stamp_error', { flowsheet_id: row.id });
      }
    }
    // Forward the lookup's real cacheHit (unlike the lml_error path, the
    // lookup succeeded here): a cached hit made no LML call, so the caller
    // should still skip the inter-row throttle.
    return { outcome: 'enrich_error', cacheHit: result.cacheHit };
  }
};

/**
 * Worker-terminal `metadata_status` values (BS#891 enum,
 * `metadata_status_enum` in shared/database/src/schema.ts; the full set is
 * pending / enriching / enriched_match / enriched_no_match /
 * failed_no_retry — kept as string literals here because the unit harness
 * maps `@wxyc/database` to a mock without the drizzle enum object).
 * Terminal = the worker finished with the row (successfully or not); the
 * job reconciles those with a marker-only stamp instead of a lookup.
 */
const WORKER_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'enriched_match',
  'enriched_no_match',
  'failed_no_retry',
]);

/**
 * EnrichRow plus the worker-lifecycle column the batch partition keys on.
 * Typed `string`, not the enum union: the partition must tolerate future
 * enum values (they fall to the leave-untouched arm, fail-safe).
 */
export type BatchRow = EnrichRow & { metadata_status: string };

/**
 * Render a numeric id array as a single PG-array-literal string param
 * (`'{1,2,3}'::int[]` at the call site) — drizzle/postgres-js splats a bare
 * JS array into N positional placeholders, which PG rejects (BS#1068 /
 * BS#1071; see `jobs/album-level-backfill/job.ts` for the incident
 * lineage). Safe by construction: callers pass numbers from our own
 * work-list. (Fifth site of this idiom in the jobs fleet — promotion to
 * `@wxyc/database` is tracked as a review follow-up.)
 */
const intArrayLiteral = (ids: readonly number[]): string => `{${ids.join(',')}}`;

/**
 * Load one work-list slice's rows by id (BS#1591). The work-list already
 * guaranteed the canonical pending filter at build time; here the marker is
 * re-checked (rows stamped out-of-band mid-run drop out) and
 * `metadata_status` is fetched so the caller can partition on the worker's
 * lifecycle — the CDC worker finalizes via status WITHOUT stamping the
 * marker, so a status-blind loader would re-enrich worker-enriched rows and
 * race in-flight claims (`applyEnrichment`'s id+marker guard remains the
 * last line of defense).
 *
 * `= ANY` does not preserve order, so the caller re-orders results to
 * work-list order.
 */
const loadBatchByIds = async (ids: number[]): Promise<BatchRow[]> => {
  if (ids.length === 0) return [];
  const idArrayLiteral = intArrayLiteral(ids);
  return unwrapRows<BatchRow>(
    await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title",
      "track_title",
      "album_id",
      "metadata_status"
    FROM ${FLOWSHEET_TABLE}
    WHERE "id" = ANY(${idArrayLiteral}::int[])
      AND "metadata_attempt_at" IS NULL
  `),
    'batch load'
  );
};

/**
 * Marker-only reconcile for rows the CDC worker already drove to a terminal
 * `metadata_status` (BS#1591 review follow-up). The enrichment happened on
 * the worker's side; stamping `metadata_attempt_at` here spends zero LML
 * budget, removes the row from every future work-list, and keeps the
 * "pending ≈ below-floor residual" retire criterion convergent — without
 * it, the marker-based cohort would grow by every worker-enriched row
 * forever and each would eventually burn a redundant lookup. The marker
 * guard keeps the stamp idempotent; `metadata_status` is left untouched
 * (it is the worker's column — `failed_no_retry` rows stay visible for
 * manual triage). Returns the number of rows actually stamped.
 */
const reconcileWorkerRows = async (ids: number[]): Promise<number> => {
  if (ids.length === 0) return 0;
  const idArrayLiteral = intArrayLiteral(ids);
  const stamped = unwrapRows<{ id: number }>(
    await db.execute(sql`
    UPDATE ${FLOWSHEET_TABLE}
    SET "metadata_attempt_at" = now()
    WHERE "id" = ANY(${idArrayLiteral}::int[])
      AND "metadata_attempt_at" IS NULL
    RETURNING "id"
  `),
    'worker reconcile'
  );
  return stamped.length;
};

const formatTotals = (totals: Totals): string =>
  `scanned=${totals.scanned} enriched_match=${totals.enriched_match} ` +
  `enriched_match_raced=${totals.enriched_match_raced} ` +
  `enriched_no_match=${totals.enriched_no_match} ` +
  `enriched_no_match_raced=${totals.enriched_no_match_raced} lml_error=${totals.lml_error} ` +
  `enrich_error=${totals.enrich_error} below_floor_skipped=${totals.below_floor_skipped} ` +
  `stale_skipped=${totals.stale_skipped} worker_reconciled=${totals.worker_reconciled} ` +
  `worker_inflight_skipped=${totals.worker_inflight_skipped}`;

/**
 * Project the run totals onto a Sentry span with numeric attributes set at
 * creation time (per the BS#1081 convention — late `setAttribute` calls index
 * numbers as strings and break sum/avg/p95 aggregation).
 *
 * The span carries an explicit `op` of `flowsheet-metadata-backfill.totals` so
 * a Sentry alert filtering `span.op:flowsheet-metadata-backfill.*` actually
 * matches it — without an `op` the span lands under a generic default op and
 * the wildcard matches nothing (the BS#1428 finding, fixed in PR #1459 for the
 * sibling rotation-artist-backfill). Every totals bucket is exposed as an
 * attribute, including `enrich_error` — the per-row DB-write-failure count
 * (#1561) that is the corruption tell the #1560 wedge needed. Before this the
 * buckets surfaced only in the structured `finished` log; now they are
 * queryable and alertable in Sentry. The name keeps the sibling
 * `${JOB_NAME}.run.totals` shape for name-pattern dashboard grouping.
 *
 * Gated on tracing being enabled (`SENTRY_TRACES_SAMPLE_RATE`, which this cron
 * defaults to 1.0 — see `logger.ts:resolveTracesSampleRate`) and on
 * `SENTRY_DSN`, so dev/CI runs emit nothing.
 */
const projectTotalsSpan = (totals: Totals): void => {
  Sentry.startSpan(
    {
      name: `${JOB_NAME}.run.totals`,
      op: `${JOB_NAME}.totals`,
      attributes: {
        'backfill.scanned': totals.scanned,
        'backfill.enriched_match': totals.enriched_match,
        'backfill.enriched_match_raced': totals.enriched_match_raced,
        'backfill.enriched_no_match': totals.enriched_no_match,
        'backfill.enriched_no_match_raced': totals.enriched_no_match_raced,
        'backfill.lml_error': totals.lml_error,
        'backfill.enrich_error': totals.enrich_error,
        // BS#1591: the deliberate below-floor residual (dashboards subtract
        // it from the pending cohort — approximate, see Totals doc), the
        // vanished-mid-run count (deletes / out-of-band stamps), and the two
        // worker-lifecycle buckets (reconciled = true worker overlap;
        // inflight = claims left untouched).
        'backfill.below_floor_skipped': totals.below_floor_skipped,
        'backfill.stale_skipped': totals.stale_skipped,
        'backfill.worker_reconciled': totals.worker_reconciled,
        'backfill.worker_inflight_skipped': totals.worker_inflight_skipped,
      },
    },
    () => {
      /* observability-only span; attributes set at creation */
    }
  );
};

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
  playFloor?: number;
  floorRecencyDays?: number;
  buildWorkList?: BuildWorkListFn;
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? resolveBatchSize();
  // The env path is guarded by requirePositiveInt, but the injectable seam
  // bypasses it — and unlike the old id-cursor loop (whose LIMIT 0 returned
  // an empty batch and broke cleanly), the work-list cursor never advances
  // for batchSize <= 0, which would spin forever. Fail loud at the seam.
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`runBackfill: batchSize must be a positive integer; got ${JSON.stringify(batchSize)}`);
  }
  const throttleMs = opts.throttleMs ?? resolveThrottleMs();
  const partition = opts.partition ?? resolvePartitionFilter();
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;
  const playFloor = opts.playFloor ?? resolvePlayFloor();
  const floorRecencyDays = opts.floorRecencyDays ?? resolveFloorRecencyDays();
  const buildList = opts.buildWorkList ?? defaultBuildWorkList;

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: batchSize,
    throttle_ms: throttleMs,
    partition: partition.description,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
    play_floor: playFloor,
    floor_recency_days: floorRecencyDays,
  });

  const totals: Totals = {
    scanned: 0,
    enriched_match: 0,
    enriched_match_raced: 0,
    enriched_no_match: 0,
    enriched_no_match_raced: 0,
    lml_error: 0,
    enrich_error: 0,
    below_floor_skipped: 0,
    stale_skipped: 0,
    worker_reconciled: 0,
    worker_inflight_skipped: 0,
  };

  // Cooperative pause (#735): yield whenever a DJ is actively touching the
  // playout. Gates the work-list build (itself a heavy read) and every
  // batch slice.
  const waitForQuietBooth = async (): Promise<void> => {
    if (liveActivityLookbackSeconds <= 0) return;
    while (await probe(liveActivityLookbackSeconds)) {
      log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
        lookback_seconds: liveActivityLookbackSeconds,
        pause_ms: liveActivityPauseMs,
      });
      if (liveActivityPauseMs > 0) await sleep(liveActivityPauseMs);
    }
  };

  await waitForQuietBooth();
  const buildStart = Date.now();
  const workList = await buildList({
    playFloor,
    recencyDays: floorRecencyDays,
    partitionFilter: partition.sqlFragment,
  });
  totals.below_floor_skipped = workList.belowFloorSkipped;
  const workListSize = workList.ids.length;
  log('info', 'worklist_built', `work-list built: ${workListSize} rows in play-descending priority`, {
    worklist_size: workListSize,
    pending_total: workList.pendingTotal,
    below_floor_skipped: workList.belowFloorSkipped,
    build_ms: Date.now() - buildStart,
    max_plays: workListSize > 0 ? workList.plays[0] : null,
    min_plays: workListSize > 0 ? workList.plays[workListSize - 1] : null,
  });

  // Monotonic cursor over the materialized work-list (BS#1591 design
  // decision 1). It advances before the slice is processed and no outcome
  // can rewind it, so a failing row — which deliberately stays
  // `metadata_attempt_at IS NULL` for the next run — can never be
  // re-selected within this run. That is the BS#1011 wedge-proof property
  // under play-descending order, where a naive head-of-cohort re-SELECT
  // would jam on the highest-play failing row forever.
  let cursor = 0;
  let batchIndex = 0;

  while (cursor < workListSize) {
    await waitForQuietBooth();

    const sliceEnd = Math.min(cursor + batchSize, workListSize);
    const sliceIds = workList.ids.slice(cursor, sliceEnd);
    const batchPlaysMax = workList.plays[cursor];
    const batchPlaysMin = workList.plays[sliceEnd - 1];
    cursor = sliceEnd;

    const rows = await loadBatchByIds(sliceIds);
    // `= ANY` returns rows in arbitrary order; restore work-list order so
    // same-artist contiguity (and the LookupCache dedup clustering it buys)
    // survives into the per-row loop. Ids coerced defensively — a driver
    // returning string ids would otherwise miss every Map lookup.
    const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
    const orderedRows = sliceIds.flatMap((id) => {
      const row = rowsById.get(id);
      return row ? [row] : [];
    });
    totals.stale_skipped += sliceIds.length - orderedRows.length;

    // Partition on the worker lifecycle (see the header's concurrent-worker
    // note): only still-`pending` rows spend an LML lookup. Worker-terminal
    // rows get the marker-only reconcile stamp; `enriching` claims — and
    // any future enum value this code doesn't know — are left completely
    // untouched (fail-safe: they stay retryable for a later run).
    const pendingRows: BatchRow[] = [];
    const reconcileIds: number[] = [];
    for (const row of orderedRows) {
      if (row.metadata_status === 'pending') {
        pendingRows.push(row);
      } else if (WORKER_TERMINAL_STATUSES.has(row.metadata_status)) {
        reconcileIds.push(Number(row.id));
      } else {
        totals.worker_inflight_skipped += 1;
      }
    }
    totals.worker_reconciled += await reconcileWorkerRows(reconcileIds);

    batchIndex += 1;
    for (const row of pendingRows) {
      const { outcome, cacheHit } = await processRow(row, { lookup: opts.lookup, enrich: opts.enrich });
      totals.scanned += 1;
      totals[outcome] += 1;
      // Throttle exists to pace LML calls (BACKFILL_THROTTLE_MS docstring
      // above). A cache hit makes no LML call, so sleeping after one is
      // wall-clock waste — at the documented 42% hit rate over ~628k
      // rows that's ~7.3h per run recovered.
      if (throttleMs > 0 && !cacheHit) await sleep(throttleMs);
    }

    const cacheFields = readCacheFields(opts.cacheStats);

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      worklist_cursor: cursor,
      batch_plays_max: batchPlaysMax,
      batch_plays_min: batchPlaysMin,
      ...totals,
      ...cacheFields,
    });
  }

  const finalCacheFields = readCacheFields(opts.cacheStats);
  log('info', 'finished', `${JOB_NAME} done. ${formatTotals(totals)}`, { ...totals, ...finalCacheFields });

  // Emit the run-level totals span carrying every bucket (incl. enrich_error)
  // as a numeric attribute, so the drain's health is queryable/alertable in
  // Sentry — not just in the log line above (BS#1563). Wrapped so a Sentry SDK
  // fault can never turn a successful drain into a non-zero exit.
  try {
    projectTotalsSpan(totals);
  } catch (error) {
    log('warn', 'totals_span_failed', 'projectTotalsSpan threw; totals already logged', {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

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
