/**
 * Backfill orchestrator. Originally the historical metadata drain (#638,
 * A.1.a of #631); retuned by BS#895 (Epic C C6) into the hourly gap-recovery
 * sweep behind the CDC enrichment consumer (`apps/enrichment-worker`,
 * BS#892).
 *
 * Iterates `flowsheet` track rows where `metadata_status = 'pending'`, calls
 * LML for each one, and applies the 10-column UPDATE via `applyEnrichment`.
 * Designed to be resumable and failure-tolerant:
 *
 *   - The WHERE filter is `entry_type='track' AND artist_name IS NOT NULL
 *     AND metadata_status = 'pending' AND add_time < now() -
 *     (graceMinutes * interval '1 minute')`, optionally ANDed with a hard
 *     `add_time > now() - (recoveryWindowHours * interval '1 hour')`
 *     ceiling. `metadata_status` (BS#891) is the explicit enrichment
 *     lifecycle enum; it's set on every row by default and flipped to a
 *     terminal value by whichever writer enriches the row (the CDC worker,
 *     this job, or the W4 self-heal pass below), so the same filter cleanly
 *     identifies the un-tried tail at any point in the lifecycle. Replaces
 *     the pre-BS#891 implicit marker (`metadata_attempt_at IS NULL`) — see
 *     `docs/migrations.md` "Attempt-at markers" and `worklist.ts`'s module
 *     docstring for the full BS#895 predicate-swap rationale.
 *   - `graceMinutes` (default 15) gives the CDC consumer first crack at a
 *     freshly-inserted row before the sweep spends an LML call on it —
 *     replaces the old 60-second guard, which existed only to dodge the
 *     — now-removed (Epic C C5 / #894) — runtime fire-and-forget writer.
 *   - `recoveryWindowHours` (default 6) is the design constraint from the
 *     2026-07-23 comment on #895: #1011 retired the historical daily drain
 *     WITHOUT draining it, so ~748k rows sit at `metadata_status='pending'`
 *     far older than any grace window. Without this ceiling the hourly
 *     sweep would match the entire undrained backlog on its first run
 *     instead of the "tens of rows/hour" C6 sizing assumes.
 *   - Within a single run, row order comes from a play-priority work-list
 *     materialized once at run start (BS#1591, `worklist.ts`): pending row
 *     ids ordered by per-artist total plays descending, with non-library
 *     artists below a configurable play-floor excluded at query time. The
 *     high-value cache-friendly head drains first; the uncacheable one-off
 *     tail stops consuming Discogs fan-out (the 2026-07-10 LML 502 flood).
 *     (In steady state under the C6 recovery-window ceiling, every
 *     candidate row is already far younger than the floor's recency
 *     exemption, so this machinery is effectively dormant — see
 *     `worklist.ts`.) A monotonic array cursor drains the list — it
 *     advances unconditionally, so a failing row can never be re-selected
 *     within a run (the BS#1011 wedge-proof property, preserved under value
 *     order where a naive head-of-cohort re-SELECT would jam on the
 *     highest-play failing row). Across runs, the WHERE filter is what
 *     restarts — the work-list doesn't need to persist. Rows inserted
 *     mid-run are not in the list and simply wait for the next run (the
 *     live enrichment-worker owns new rows anyway).
 *   - A per-row failure — an LML throw (`lml_error`) or a DB-write throw
 *     (`enrich_error`, e.g. a mojibake title overflowing a varchar column,
 *     BS#1011) — is logged, counted, and the loop continues. The row stays
 *     `metadata_status = 'pending'`, so the next sweep retries it; the
 *     in-run cursor still advances, so one bad row can never wedge the
 *     drain. BS#1094 Layer 3 carve-out: an `LmlAuthError` (401/403 — the
 *     shared `LML_API_KEY` bearer was rejected) is NOT treated as a
 *     per-row `lml_error` — it aborts the whole run instead. See
 *     `processRow`'s doc comment for the full rationale.
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
 *   - W4 self-heal (epic #1810, folded into this issue per the 2026-07-25
 *     scoping comment): a small, separate pass ahead of the main drain
 *     re-selects rotation-linked rows stuck at `metadata_status =
 *     'enriched_no_match'` whose linked `rotation.discogs_release_id` has
 *     transitioned NULL→present since this job last tried them —
 *     state-change-gated, not blind time. See
 *     `worklist.ts:buildRotationSelfHealCandidates` for the exact gate and
 *     `enrich.ts`'s `fromStatus` option for how the same `applyEnrichment`
 *     write path is reused against a different starting status.
 *
 * Concurrent CDC-worker overlap: the live enrichment worker
 * (`apps/enrichment-worker`) finalizes rows via `metadata_status` — the
 * SAME column this job's own selection predicate now reads (BS#895), so a
 * row the worker claims (`'pending' → 'enriching'`) or finalizes
 * (`→ 'enriched_match'` / `'enriched_no_match'` / `'failed_no_retry'`)
 * simply stops matching this job's WHERE on the very next statement — no
 * separate reconcile pass is needed to keep the pending cohort converging.
 * The batch loader still re-checks `metadata_status = 'pending'` at load
 * time and still fetches the column so the (now largely dormant, kept as a
 * fail-safe) worker-lifecycle partition below can leave a row the worker
 * claimed between the work-list snapshot and this row's turn in the loop
 * completely untouched rather than racing it. That race window is seconds
 * wide and benign either way: a row that flips out of `'pending'` in that
 * window simply vanishes from `loadBatchByIds`'s result (counted as
 * `stale_skipped`, same bucket as a hard-deleted row) and both writers
 * would have persisted the same top-match payload regardless.
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
  intArrayLiteral,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
  requireNonNegativeInt,
  requirePositiveInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import { LmlAuthError, lmlApiKeyFingerprint, type LookupResponse } from '@wxyc/lml-client';
import type { EnrichRow, EnrichOutcome } from './enrich.js';
import { applyEnrichment as defaultApplyEnrichment, stampDeadLetter as defaultStampDeadLetter } from './enrich.js';
import type { LookupResult } from './lml-fetch.js';
import {
  probeDiscogsBreaker as defaultProbeDiscogsBreaker,
  resolveBreakerMaxPauseMs,
  resolveBreakerPauseMs,
  resolveBreakerProbeIntervalMs,
  shouldPauseForBreaker,
  BreakerPauseCeilingExceededError,
  type BreakerProbeResult,
  type CheckDiscogsBreakerFn,
} from './lml-health.js';
import { captureError, log } from './logger.js';
import {
  buildWorkList as defaultBuildWorkList,
  FLOWSHEET_TABLE,
  LIBRARY_TABLE,
  unwrapRows,
  type BuildWorkListFn,
  type BuildSelfHealCandidatesFn,
} from './worklist.js';

/**
 * BS#895 review follow-up (finding #4): reports how many `metadata_status =
 * 'pending'` rows are older than the `recoveryWindowHours` ceiling — the
 * rows the ceiling silently strands (see
 * `worklist.ts:countStrandedPastRecoveryWindow`'s docstring for the full
 * rationale). Signature matches the real function so tests can inject a
 * stub without depending on `db.execute` mock-queue ordering.
 */
export type CountStrandedPastRecoveryWindowFn = (recoveryWindowHours: number) => Promise<number>;

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
 * the recency exemption — only sensible for a pure historical catch-up run
 * (`recoveryWindowHours=0`); the live BS#895 hourly cron keeps it non-zero
 * (though the exemption is largely dormant once the recovery-window ceiling
 * is active — see `worklist.ts`).
 */
export const resolveFloorRecencyDays = (raw: string | undefined = process.env.BACKFILL_FLOOR_RECENCY_DAYS): number =>
  requireNonNegativeInt(raw, 'BACKFILL_FLOOR_RECENCY_DAYS', FLOOR_RECENCY_DAYS_DEFAULT, {
    unit: 'days',
    note: 'Use 0 to disable the recency exemption from the play-floor.',
  });

/**
 * Default consumer grace window in minutes (BS#895 / Epic C C6): rows
 * younger than this are never eligible for the sweep, regardless of the
 * play-floor/eligibility arms — the CDC consumer gets first crack. Replaces
 * the pre-C6 60-second race guard, which existed only to dodge the — now
 * removed (#894) — runtime fire-and-forget writer. 15 matches the ticket's
 * explicit design (`WHERE metadata_status = 'pending' AND inserted_at <
 * now() - interval '15 minutes'`).
 */
export const GRACE_MINUTES_DEFAULT = 15;

/**
 * Resolve `BACKFILL_GRACE_MINUTES` (BS#895). `0` disables the grace window
 * (every pending row is immediately eligible) — only sensible for a
 * catch-up run; the live hourly cron keeps it non-zero so it doesn't race
 * the consumer on a row inserted seconds ago.
 */
export const resolveGraceMinutes = (raw: string | undefined = process.env.BACKFILL_GRACE_MINUTES): number =>
  requireNonNegativeInt(raw, 'BACKFILL_GRACE_MINUTES', GRACE_MINUTES_DEFAULT, {
    unit: 'minutes',
    note: 'Use 0 to disable the consumer grace window.',
  });

/**
 * Default recovery-window ceiling in hours (BS#895 / Epic C C6, the
 * 2026-07-23 design constraint on #895): rows older than this are excluded
 * from the sweep predicate entirely. Required because #1011 retired the
 * historical daily drain WITHOUT draining it — ~748k rows sit at
 * `metadata_status='pending'` far older than any grace window, and without
 * this ceiling the hourly sweep would match the whole undrained backlog on
 * its first run instead of the "tens of rows/hour" the C6 sizing assumes,
 * false-triggering the "thousands → consumer leak" alarm. 6 hours covers a
 * deploy, a restart, or a full evening's CDC event-loss window (the
 * scenarios #895's body names) with comfortable margin, while staying two
 * orders of magnitude below the age of the undrained backlog.
 */
export const RECOVERY_WINDOW_HOURS_DEFAULT = 6;

/**
 * Resolve `BACKFILL_RECOVERY_WINDOW_HOURS` (BS#895). `0` disables the
 * ceiling — only sensible for a deliberate historical catch-up run (e.g. a
 * future one-shot drain of the retired backlog), NEVER for the live hourly
 * cron: with the ceiling off the sweep matches the entire undrained
 * historical `pending` cohort on every run.
 */
export const resolveRecoveryWindowHours = (
  raw: string | undefined = process.env.BACKFILL_RECOVERY_WINDOW_HOURS
): number =>
  requireNonNegativeInt(raw, 'BACKFILL_RECOVERY_WINDOW_HOURS', RECOVERY_WINDOW_HOURS_DEFAULT, {
    unit: 'hours',
    note: 'Use 0 to disable the recovery-window ceiling (historical catch-up runs only — never the live hourly cron).',
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
export type LookupFn = (
  artist: string,
  album?: string,
  track?: string,
  // BS#1294 (1c): pre-read `row.discogs_unavailable`, forwarded to the
  // BS#1293 gate.
  discogsUnavailable?: boolean
) => Promise<LookupResult>;

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
 * row stays at whatever `metadata_status` it entered `processRow` with
 * (`'pending'` for the main sweep, `'enriched_no_match'` for the W4
 * self-heal re-attempt) and the next sweep retries it. Fail safe toward
 * retry, never toward silently dead-lettering a row a retry could have
 * enriched.
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
  // was hard-deleted mid-run (flowsheet deleteEntry), or (BS#895) the CDC
  // worker claimed or finalized it between the work-list snapshot and this
  // slice's load. Since `loadBatchByIds` re-checks `metadata_status =
  // 'pending'` (the same predicate the work-list itself used), a row the
  // worker touched in that narrow window now surfaces HERE rather than as
  // `worker_reconciled` — see that field's doc for the pre-BS#895 shape,
  // where the broader marker-based re-check routinely caught worker-claimed
  // rows this bucket couldn't see.
  stale_skipped: number;
  // BS#1591 review follow-up. Dormant since BS#895 (see `loadBatchByIds`'s
  // docstring) — kept as a fail-safe bucket, not a routinely-exercised
  // signal. Pre-BS#895: work-list rows the CDC worker had already driven to
  // a terminal `metadata_status` (enriched_match / enriched_no_match /
  // failed_no_retry) by batch-load time; the job stamped
  // `metadata_attempt_at` only, closing the old marker state machine.
  worker_reconciled: number;
  // BS#1591 review follow-up. Also dormant since BS#895 for the same
  // reason. Pre-BS#895: work-list rows the worker had claimed
  // (`metadata_status = 'enriching'`) — or carried an unrecognized future
  // status — at batch-load time, left completely untouched.
  worker_inflight_skipped: number;
  // BS#895 review follow-up (finding #4): `metadata_status = 'pending'`
  // rows older than `recoveryWindowHours` — the cohort the ceiling
  // excludes from every sweep, permanently, with no automated path back.
  // The ceiling is load-bearing (it's what keeps the hourly sweep from
  // re-matching the ~748k-row undrained historical backlog #1011 left
  // behind), so this doesn't remove it — it makes the silent exclusion
  // observable instead. See `worklist.ts:countStrandedPastRecoveryWindow`.
  // 0 both when nothing is stranded AND when the counting pass wasn't
  // wired in (it's opt-in via `runBackfill`'s `countStrandedPastRecoveryWindow`
  // option, mirroring the self-heal gate below, so every pre-existing test
  // that omits it keeps exercising byte-identical behavior).
  stranded_past_recovery_window: number;
  // BS#895 / epic #1810 W4: rotation-linked `enriched_no_match` rows the
  // self-heal pass found this run, whose linked `rotation.discogs_release_id`
  // transitioned NULL→present since this job's last attempt (or were never
  // attempted by this job). See `worklist.ts:buildRotationSelfHealCandidates`.
  self_heal_candidates: number;
  // BS#895 review follow-up (finding #5a): self-heal candidate ids that
  // vanished between `buildRotationSelfHealCandidates`' snapshot and
  // `loadSelfHealRowsByIds`' load — mirrors the main loop's `stale_skipped`
  // bucket so the self-heal cohort reconciles (`candidates == skipped +
  // scanned`, same identity `stale_skipped` gives the main sweep).
  self_heal_skipped: number;
  // BS#895 review follow-up (finding #5b): self-heal rows actually driven
  // through `processRow` this run. Kept as its OWN counter — and
  // `self_heal_resolved` / `self_heal_no_match` / `self_heal_lml_error` /
  // `self_heal_enrich_error` below as their own counters — rather than
  // folding into the shared `scanned` / `enriched_match` / `enriched_no_match`
  // / `lml_error` / `enrich_error` buckets, so a dashboard reading those
  // shared buckets isn't silently inflated by a self-heal catch-up burst
  // (the very "< 100 rows median" signal this ticket's C6 sizing criterion
  // depends on).
  self_heal_scanned: number;
  // Of `self_heal_scanned`, how many the re-attempt resolved to a real
  // Discogs match (`enriched_match` or the raced variant — same data
  // outcome either way, see `applyEnrichment`'s race-detector doc).
  self_heal_resolved: number;
  // Of `self_heal_scanned`, how many stayed unresolved after the re-attempt
  // (`enriched_no_match` or its raced variant) — LML still couldn't answer
  // even with the rotation id now present (see worklist.ts's coupling note
  // on `buildRotationSelfHealCandidates`).
  self_heal_no_match: number;
  self_heal_lml_error: number;
  self_heal_enrich_error: number;
  // BS#1995 Arm 3: rows where `applyEnrichment` refused to write a verdict
  // because LML's Discogs breaker was open (`degraded_reason:
  // 'upstream_unavailable'`) — see enrich.ts. The row stays `pending` and
  // is retried on a later sweep; it is deliberately NOT folded into
  // `lml_error` (LML answered; it just couldn't ask Discogs) or
  // `enriched_no_match` (that would be exactly the 2026-08-03/04 incident).
  upstream_unavailable_skipped: number;
  // Same classification, but for a row the W4 self-heal pass re-attempted
  // (`fromStatus: 'enriched_no_match'`). Kept in its own bucket for the
  // same reason every other `self_heal_*` counter is separate from the
  // main sweep's — see the self_heal_scanned doc above.
  self_heal_upstream_unavailable_skipped: number;
  // BS#1995 Arm 2: how many times the drain probed LML's `/health`
  // Discogs-breaker signal, and how many of those probes found a
  // non-`closed` breaker and paused the drain. Checked per row, but the
  // underlying network call is throttled to at most once every
  // `breakerProbeIntervalMs` — see `waitForClosedBreaker`'s doc comment.
  breaker_probes: number;
  breaker_pauses: number;
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
 * stays at whatever `metadata_status` it entered this call with so the next
 * sweep retries it. `deps.enrich` / `deps.stampDeadLetter` are injected so
 * the same function drives both the main sweep (`fromStatus: 'pending'`,
 * the default inside `enrich.ts`) and the W4 rotation self-heal pass
 * (`fromStatus: 'enriched_no_match'`, wired by the caller in `runBackfill`)
 * without duplicating this loop.
 *
 * The enrich catch is load-bearing, not defensive boilerplate: without it a
 * single row whose synthesized search URL overflows a varchar(512) column
 * (mojibake titles from the legacy latin1→UTF-8 ETL) throws mid-batch, the
 * throw propagates to `main` → exit 1, and because the failed UPDATE never
 * flips the row off its starting status, the work-list/candidate-list
 * re-selects that same row on the next run and crashes again — a permanent
 * stall (BS#1011). Isolating the throw here lets the cursor advance past it.
 *
 * Dead-lettering (BS#1562): isolating the throw kept the cursor moving but
 * still left the poison row retryable forever, so it was re-attempted (and
 * re-failed, and re-logged) every run — the pending cohort never converged,
 * breaking BS#1011's "cohort == 0" retire criterion (and its C6-successor
 * "recovery sweep finds < 100 rows" criterion). When the SQLSTATE marks the
 * failure *permanent* (data exception / integrity violation —
 * `isPermanentEnrichError`), we flip the row to `failed_no_retry` via
 * `stampDeadLetter` so it leaves the cohort. Genuinely transient failures
 * (deadlock, serialization, connection drop, or an unreadable code) are left
 * unstamped and retryable, exactly as before.
 *
 * BS#1094 Layer 3 carve-out: an `LmlAuthError` (401/403 — the shared
 * `LML_API_KEY` bearer was rejected) is NOT swallowed into the `lml_error`
 * bucket. Every other LML throw is a per-row, plausibly-transient failure
 * that the next sweep should simply retry; an auth rejection means EVERY
 * row in this run (and the next, and the next) will fail identically until
 * an operator re-coordinates the bearer rotation across consumers — looping
 * on it just produces thousands of individually-unremarkable `lml_error`
 * Sentry events with no aggregated signal that auth, specifically, is
 * broken (the silent-stall failure mode BS#1094 was filed to close). So
 * this branch logs + captures with a bearer fingerprint for triage, then
 * RETHROWS — the throw propagates out of this run's batch loop, out of
 * `runBackfill`, to `job.ts`'s top-level catch, which sets
 * `process.exitCode = 1`. A loud, visible cron failure in GHA / Railway
 * beats an invisible per-row loop. Acceptable per BS#1094's documented
 * tradeoff: a brief auth blip kills one hourly run; the cron retries next
 * cycle regardless.
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
    result = await deps.lookup(artist, album, track, row.discogs_unavailable);
  } catch (error) {
    if (error instanceof LmlAuthError) {
      const bearerFingerprint = lmlApiKeyFingerprint() ?? 'unset';
      Sentry.addBreadcrumb({
        category: 'lml.auth',
        message: `LML rejected the shared bearer with ${error.statusCode}`,
        level: 'error',
        data: { bearer_fingerprint: bearerFingerprint, status_code: error.statusCode, flowsheet_id: row.id },
      });
      log(
        'error',
        'lml_auth_error',
        `LML rejected the shared LML_API_KEY bearer (status ${error.statusCode}) on flowsheet.id=${row.id} — aborting run instead of looping`,
        { flowsheet_id: row.id, status_code: error.statusCode, bearer_fingerprint: bearerFingerprint }
      );
      captureError(error, 'lml_auth_error', {
        flowsheet_id: row.id,
        artist,
        album,
        track,
        status_code: error.statusCode,
        bearer_fingerprint: bearerFingerprint,
      });
      throw error;
    }
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
    // flip it to `failed_no_retry` so it leaves whichever cohort it entered
    // from (`'pending'` or, for W4 self-heal, `'enriched_no_match'`).
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
 * Load one work-list slice's rows by id (BS#1591; predicate cut over to
 * `metadata_status` by BS#895). The work-list already guaranteed the
 * canonical pending filter at build time; here the status is re-checked
 * (rows the CDC worker claimed or finalized between the work-list snapshot
 * and this slice's load drop out) and `metadata_status` is fetched so the
 * caller can partition on the worker's lifecycle. Since the work-list's own
 * SELECT (`worklist.ts`) already filters on `metadata_status = 'pending'`,
 * this re-check is now the SAME predicate as the selection — in steady
 * state every returned row already has `metadata_status = 'pending'`, so
 * the worker-lifecycle partition below is a fail-safe against the narrow
 * mid-run race window, not a routinely-exercised path (contrast the
 * pre-BS#895 shape, where the broader `metadata_attempt_at IS NULL`
 * predicate routinely returned worker-claimed rows that needed partitioning
 * out here).
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
      f."id",
      f."artist_name",
      f."album_title",
      f."track_title",
      f."album_id",
      f."metadata_status",
      COALESCE(l."discogs_unavailable", false) AS "discogs_unavailable"
    FROM ${FLOWSHEET_TABLE} f
    LEFT JOIN ${LIBRARY_TABLE} l ON f."album_id" = l."id"
    WHERE f."id" = ANY(${idArrayLiteral}::int[])
      AND f."metadata_status" = 'pending'
  `),
    'batch load'
  );
};

/**
 * Load the W4 self-heal candidate slice's rows by id (BS#895 / epic #1810).
 * Mirrors `loadBatchByIds`'s re-check-at-load-time shape, but against
 * `metadata_status = 'enriched_no_match'` — the status these candidates are
 * re-attempted FROM (see `enrich.ts`'s `fromStatus` option) — instead of
 * `'pending'`. No worker-lifecycle partition is needed here: a terminal
 * `'enriched_no_match'` row is never claimed by the CDC worker (the worker
 * only claims `'pending'` rows via new CDC INSERT events), so the only
 * realistic way a candidate drops out between the worklist snapshot and
 * this load is a concurrent overlapping run of this same job — rare for an
 * hourly single-instance cron, but the re-check makes it safe regardless.
 */
const loadSelfHealRowsByIds = async (ids: number[]): Promise<EnrichRow[]> => {
  if (ids.length === 0) return [];
  const idArrayLiteral = intArrayLiteral(ids);
  return unwrapRows<EnrichRow>(
    await db.execute(sql`
    SELECT
      f."id",
      f."artist_name",
      f."album_title",
      f."track_title",
      f."album_id",
      COALESCE(l."discogs_unavailable", false) AS "discogs_unavailable"
    FROM ${FLOWSHEET_TABLE} f
    LEFT JOIN ${LIBRARY_TABLE} l ON f."album_id" = l."id"
    WHERE f."id" = ANY(${idArrayLiteral}::int[])
      AND f."metadata_status" = 'enriched_no_match'
  `),
    'self-heal batch load'
  );
};

/**
 * Marker-only reconcile for rows the CDC worker already drove to a terminal
 * `metadata_status` (BS#1591 review follow-up). Dormant since BS#895 — see
 * `loadBatchByIds`'s docstring — because `loadBatchByIds`'s own WHERE now
 * excludes non-`'pending'` rows, so `reconcileIds` (below) is empty in
 * steady state. Kept as a fail-safe: if a future caller ever widens
 * `loadBatchByIds` back to a broader predicate, worker-terminal rows still
 * get a zero-LML-cost marker stamp here instead of a redundant lookup.
 * `metadata_status` is left untouched (it is the worker's column —
 * `failed_no_retry` rows stay visible for manual triage). Returns the
 * number of rows actually stamped.
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
  `enrich_error=${totals.enrich_error} upstream_unavailable_skipped=${totals.upstream_unavailable_skipped} ` +
  `below_floor_skipped=${totals.below_floor_skipped} ` +
  `stale_skipped=${totals.stale_skipped} worker_reconciled=${totals.worker_reconciled} ` +
  `worker_inflight_skipped=${totals.worker_inflight_skipped} ` +
  `stranded_past_recovery_window=${totals.stranded_past_recovery_window} ` +
  `self_heal_candidates=${totals.self_heal_candidates} self_heal_skipped=${totals.self_heal_skipped} ` +
  `self_heal_scanned=${totals.self_heal_scanned} self_heal_resolved=${totals.self_heal_resolved} ` +
  `self_heal_no_match=${totals.self_heal_no_match} self_heal_lml_error=${totals.self_heal_lml_error} ` +
  `self_heal_enrich_error=${totals.self_heal_enrich_error} ` +
  `self_heal_upstream_unavailable_skipped=${totals.self_heal_upstream_unavailable_skipped} ` +
  `breaker_probes=${totals.breaker_probes} breaker_pauses=${totals.breaker_pauses}`;

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
        'backfill.upstream_unavailable_skipped': totals.upstream_unavailable_skipped,
        // BS#1591: the deliberate below-floor residual (dashboards subtract
        // it from the pending cohort — approximate, see Totals doc), the
        // vanished-mid-run count (deletes / out-of-band stamps), and the two
        // worker-lifecycle buckets (reconciled = true worker overlap;
        // inflight = claims left untouched).
        'backfill.below_floor_skipped': totals.below_floor_skipped,
        'backfill.stale_skipped': totals.stale_skipped,
        'backfill.worker_reconciled': totals.worker_reconciled,
        'backfill.worker_inflight_skipped': totals.worker_inflight_skipped,
        // BS#895 review follow-up (finding #4): rows the recovery-window
        // ceiling has permanently excluded from the sweep. Read this as a
        // time series in Sentry (e.g. an anomaly-detection alert on the
        // attribute's trend, mirroring the org's CloudWatch
        // ANOMALY_DETECTION_BAND convention) — a single run can't tell
        // "non-zero" from "non-zero and growing" on its own.
        'backfill.stranded_past_recovery_window': totals.stranded_past_recovery_window,
        // BS#895 / epic #1810 W4: self-heal's OWN counters, deliberately
        // separate from the shared scanned/enriched_match/enriched_no_match/
        // lml_error/enrich_error buckets above (review finding #5b) so a
        // self-heal catch-up burst can't silently inflate the main sweep's
        // "< 100 rows median" signal.
        'backfill.self_heal_candidates': totals.self_heal_candidates,
        'backfill.self_heal_skipped': totals.self_heal_skipped,
        'backfill.self_heal_scanned': totals.self_heal_scanned,
        'backfill.self_heal_resolved': totals.self_heal_resolved,
        'backfill.self_heal_no_match': totals.self_heal_no_match,
        'backfill.self_heal_lml_error': totals.self_heal_lml_error,
        'backfill.self_heal_enrich_error': totals.self_heal_enrich_error,
        'backfill.self_heal_upstream_unavailable_skipped': totals.self_heal_upstream_unavailable_skipped,
        // BS#1995 Arm 2: breaker-gate activity this run — how many times
        // the drain checked LML's `/health` Discogs breaker and how many
        // of those checks found it non-`closed` and paused.
        'backfill.breaker_probes': totals.breaker_probes,
        'backfill.breaker_pauses': totals.breaker_pauses,
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
  /**
   * BS#1995 Arm 2. Low-duty-cycle gate on LML's `/health` Discogs breaker
   * (`lml-health.ts`). Checked on every row (a cheap `Date.now()` read —
   * see `waitForClosedBreaker` below), but the actual `/health` network
   * call only fires once `breakerProbeIntervalMs` has elapsed since the
   * last one; a non-`closed` breaker pauses the drain for `breakerPauseMs`
   * and re-probes rather than continuing to write verdicts. Unlike
   * `buildSelfHealCandidates` / `countStrandedPastRecoveryWindow` below,
   * `job.ts` does NOT explicitly pass this — production wiring happens
   * entirely through this option's own `?? defaultProbeDiscogsBreaker`
   * fallback a few lines down, the same way `checkLiveActivity` above gets
   * its real implementation. Tests inject a stub to control probe timing/
   * outcomes, or set `breakerProbeIntervalMs: 0` to disable the gate
   * outright when a test doesn't care about it.
   */
  checkDiscogsBreaker?: CheckDiscogsBreakerFn;
  /** Wall-clock ms between breaker probes. `0` disables the gate entirely. */
  breakerProbeIntervalMs?: number;
  /** Sleep between re-probes while the breaker stays non-`closed`. */
  breakerPauseMs?: number;
  /** BS#1995 review B3. Cumulative pause-time ceiling; `0` uncapped. Exceeding it throws `BreakerPauseCeilingExceededError`. */
  breakerMaxPauseMs?: number;
  /**
   * Test-only clock seam for the breaker gate's OWN timing (probe cadence
   * gating + the req/min pairing math) — defaults to the real `Date.now`.
   * Deliberately scoped to just the breaker gate (not threaded through
   * `worklist_built`'s unrelated `build_ms` timing or anything else in this
   * function) so a test can drive fully deterministic probe-interval and
   * rate-math scenarios without needing to account for every OTHER
   * `Date.now()` call this function happens to make.
   */
  breakerNow?: () => number;
  cacheStats?: CacheStatsFn;
  playFloor?: number;
  floorRecencyDays?: number;
  graceMinutes?: number;
  recoveryWindowHours?: number;
  buildWorkList?: BuildWorkListFn;
  /**
   * BS#895 / epic #1810 W4. Gate for the rotation self-heal pass: when
   * provided, `runBackfill` runs the pass (candidates from this fn, enriched
   * via `selfHealEnrich`/`selfHealStampDeadLetter` below); when omitted, the
   * pass is skipped entirely — no extra `db.execute` call, byte-identical to
   * pre-W4 behavior. `job.ts` always wires the real
   * `buildRotationSelfHealCandidates` in production; tests that don't care
   * about W4 simply omit it.
   */
  buildSelfHealCandidates?: BuildSelfHealCandidatesFn;
  selfHealEnrich?: EnrichFn;
  selfHealStampDeadLetter?: StampDeadLetterFn;
  /**
   * BS#895 review follow-up (finding #4). Gate for the stranded-past-
   * recovery-window count: when provided, `runBackfill` runs it once at
   * run start and reports `totals.stranded_past_recovery_window`; when
   * omitted, the count is skipped (stays 0) — no extra `db.execute` call,
   * so every pre-existing test that omits it keeps exercising
   * byte-identical behavior. Same opt-in shape as `buildSelfHealCandidates`
   * above. `job.ts` always wires the real
   * `worklist.ts:countStrandedPastRecoveryWindow` in production.
   */
  countStrandedPastRecoveryWindow?: CountStrandedPastRecoveryWindowFn;
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
  const probeBreaker = opts.checkDiscogsBreaker ?? defaultProbeDiscogsBreaker;
  const breakerProbeIntervalMs = opts.breakerProbeIntervalMs ?? resolveBreakerProbeIntervalMs();
  const breakerPauseMs = opts.breakerPauseMs ?? resolveBreakerPauseMs();
  const breakerMaxPauseMs = opts.breakerMaxPauseMs ?? resolveBreakerMaxPauseMs();
  const breakerNow = opts.breakerNow ?? Date.now;
  const playFloor = opts.playFloor ?? resolvePlayFloor();
  const floorRecencyDays = opts.floorRecencyDays ?? resolveFloorRecencyDays();
  const graceMinutes = opts.graceMinutes ?? resolveGraceMinutes();
  const recoveryWindowHours = opts.recoveryWindowHours ?? resolveRecoveryWindowHours();
  const buildList = opts.buildWorkList ?? defaultBuildWorkList;

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: batchSize,
    throttle_ms: throttleMs,
    partition: partition.description,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
    breaker_probe_interval_ms: breakerProbeIntervalMs,
    breaker_pause_ms: breakerPauseMs,
    breaker_max_pause_ms: breakerMaxPauseMs,
    play_floor: playFloor,
    floor_recency_days: floorRecencyDays,
    grace_minutes: graceMinutes,
    recovery_window_hours: recoveryWindowHours,
  });

  const totals: Totals = {
    scanned: 0,
    enriched_match: 0,
    enriched_match_raced: 0,
    enriched_no_match: 0,
    enriched_no_match_raced: 0,
    lml_error: 0,
    enrich_error: 0,
    upstream_unavailable_skipped: 0,
    below_floor_skipped: 0,
    stale_skipped: 0,
    worker_reconciled: 0,
    worker_inflight_skipped: 0,
    stranded_past_recovery_window: 0,
    self_heal_candidates: 0,
    self_heal_skipped: 0,
    self_heal_scanned: 0,
    self_heal_resolved: 0,
    self_heal_no_match: 0,
    self_heal_lml_error: 0,
    self_heal_enrich_error: 0,
    self_heal_upstream_unavailable_skipped: 0,
    breaker_probes: 0,
    breaker_pauses: 0,
  };

  // BS#1995 Arm 2 (redesigned per review B1/B3/D1/D2/D3). Run-scoped
  // breaker-gate state.
  //
  // `breakerLastProbeAttemptAtMs` gates HOW OFTEN a probe fires at all
  // (B1: time-driven, checked cheaply on every row, not once per batch) —
  // it advances on every ATTEMPT, success or failure, so an unreachable
  // `/health` endpoint can't turn "probe at most every
  // breakerProbeIntervalMs" into "probe every row" by never advancing.
  //
  // `breakerLastMeasurement` is a SEPARATE, PAIRED (timestamp, counter)
  // reading used only for the req/min math (D2): it advances ONLY
  // together, and ONLY on a probe that returned a real
  // `discogs_live_requests_total`. Advancing the clock half of this pair
  // on a failed/unconfigured probe made the NEXT successful probe's
  // elapsed-time window longer than its counter delta and roughly doubled
  // the reported rate — review caught this before it shipped.
  let breakerLastProbeAttemptAtMs: number | null = null;
  let breakerLastMeasurement: { atMs: number; liveRequestsTotal: number } | null = null;
  let breakerLatestOutcome: BreakerProbeResult['outcome'] | null = null;
  let breakerLatestReqPerMin: number | null = null;
  // B3: cumulative pause time across the WHOLE run (main sweep + W4
  // self-heal share this single counter), mirroring
  // `LIVE_ACTIVITY_MAX_PAUSE_MS`'s "cumulative pause budget per run"
  // semantics in `jobs/rotation-release-id-pollution-check`.
  let breakerTotalPauseMs = 0;

  const probeBreakerAndMeasure = async (): Promise<BreakerProbeResult> => {
    const result = await probeBreaker();
    totals.breaker_probes += 1;
    breakerLastProbeAttemptAtMs = breakerNow();
    breakerLatestOutcome = result.outcome;

    if (result.outcome === 'probe_error') {
      log('warn', 'breaker_probe_failed', 'LML /health breaker probe failed; failing open (drain continues)', {
        error_message: result.error,
      });
    }

    if (result.liveRequestsTotal === null) {
      // No counter reading this probe (unconfigured / probe_error / an
      // unreadable body). Leave the paired measurement untouched (D2) —
      // `readBreakerFields` below reports the last VALID reading, which
      // may now be one probe interval stale; that staleness is bounded by
      // `breakerProbeIntervalMs` and self-evident from the accompanying
      // `breaker_probe_failed` warn line, so it isn't nulled out.
      return result;
    }

    if (breakerLastMeasurement !== null) {
      const deltaRequests = result.liveRequestsTotal - breakerLastMeasurement.liveRequestsTotal;
      const deltaMs = breakerLastProbeAttemptAtMs - breakerLastMeasurement.atMs;
      if (deltaRequests < 0) {
        // D1: `discogs_live_requests_total` is a per-LML-PROCESS counter
        // read through a load balancer (documented limitation, not fixed
        // here — see lml-health.ts's module docstring). A negative delta
        // means either that process restarted between probes, or this
        // probe landed on a DIFFERENT process than the last one — either
        // way it isn't a real measurement. Log it as explicitly INVALID
        // rather than silently reporting null with no explanation, so an
        // operator watching `batch_done` can tell "no signal yet" apart
        // from "the signal just contradicted itself."
        log(
          'warn',
          'breaker_req_per_min_invalid',
          'discogs_live_requests_total went backwards between probes (process restart, or a per-process signal behind a load balancer — see lml-health.ts) — not a real measurement',
          {
            previous_live_requests_total: breakerLastMeasurement.liveRequestsTotal,
            current_live_requests_total: result.liveRequestsTotal,
          }
        );
        breakerLatestReqPerMin = null;
      } else if (deltaMs > 0) {
        breakerLatestReqPerMin = deltaRequests / (deltaMs / 60_000);
      } else {
        breakerLatestReqPerMin = null;
      }
    } else {
      breakerLatestReqPerMin = null;
    }
    breakerLastMeasurement = { atMs: breakerLastProbeAttemptAtMs, liveRequestsTotal: result.liveRequestsTotal };
    return result;
  };

  // Cooperative pause's sibling for BS#1995 Arm 2 (review B1 redesign):
  // yield whenever LML's Discogs breaker is open/half_open. Checked on
  // EVERY row (a cheap `Date.now()` comparison — "not per row" binds the
  // NETWORK CALL below, per the ticket's explicit constraint, not this
  // check), but the underlying `/health` request only actually fires once
  // `breakerProbeIntervalMs` has elapsed since the last attempt. A
  // batch-boundary cadence was tried first and rejected in review: at this
  // job's own recommended catch-up rate (`BACKFILL_LML_RATE_PER_MIN=6`,
  // see the job README) a 500-row default batch takes ~83 minutes, so a
  // breaker that opened one row into a batch would run the drain,
  // undetected, for the next hour-plus — reproducing the incident at the
  // exact resolution this gate exists to prevent. `breakerProbeIntervalMs
  // <= 0` disables the gate outright (no probes, always fails open).
  const waitForClosedBreaker = async (): Promise<void> => {
    if (breakerProbeIntervalMs <= 0) return;
    const now = breakerNow();
    if (breakerLastProbeAttemptAtMs !== null && now - breakerLastProbeAttemptAtMs < breakerProbeIntervalMs) {
      return;
    }
    let result = await probeBreakerAndMeasure();
    while (shouldPauseForBreaker(result)) {
      totals.breaker_pauses += 1;
      log('warn', 'breaker_pause', `LML Discogs breaker is ${result.outcome}; pausing drain ${breakerPauseMs}ms`, {
        breaker_state: result.outcome,
        pause_ms: breakerPauseMs,
        total_pause_ms: breakerTotalPauseMs,
      });
      if (breakerPauseMs > 0) {
        await sleep(breakerPauseMs);
        breakerTotalPauseMs += breakerPauseMs;
      }
      // B3: a pause loop with no ceiling is invisible exactly when it
      // matters most — this runs BEFORE the first `batch_done`, so a run
      // that pauses for its entire lifetime emits no `batch_done`, no
      // `finished`, and no Sentry totals span (the July 2026 incident had
      // LML's breaker stuck HALF_OPEN for ~8h; the next cron tick's
      // `docker rm -f` would have ended that as a silent zero-progress
      // run). A wedged breaker must be loud.
      if (breakerMaxPauseMs > 0 && breakerTotalPauseMs >= breakerMaxPauseMs) {
        const message =
          `LML Discogs breaker has been non-closed for a cumulative ${breakerTotalPauseMs}ms this run ` +
          `(>= BACKFILL_BREAKER_MAX_PAUSE_MS=${breakerMaxPauseMs}ms); aborting instead of pausing indefinitely`;
        log('error', 'breaker_pause_ceiling_exceeded', message, {
          total_pause_ms: breakerTotalPauseMs,
          breaker_max_pause_ms: breakerMaxPauseMs,
          breaker_state: result.outcome,
        });
        Sentry.captureMessage(`${JOB_NAME}.breaker_pause_ceiling_exceeded`, {
          level: 'error',
          tags: { step: 'breaker_pause_ceiling_exceeded' },
          extra: {
            total_pause_ms: breakerTotalPauseMs,
            breaker_max_pause_ms: breakerMaxPauseMs,
            breaker_state: result.outcome,
          },
        });
        throw new BreakerPauseCeilingExceededError(message);
      }
      result = await probeBreakerAndMeasure();
    }
  };

  const readBreakerFields = (): {
    // S5: renamed from `discogs_breaker_state` — this field carries PROBE
    // OUTCOMES (`unconfigured`, `probe_error`), not only real breaker
    // states, and the README's "back off on anything other than closed"
    // guidance was accidentally telling operators to back off on the two
    // outcomes the gate deliberately treats as proceed. The name now says
    // what it actually is.
    discogs_breaker_probe_outcome: BreakerProbeResult['outcome'] | null;
    discogs_live_requests_total: number | null;
    discogs_req_per_min_measured: number | null;
    // D3: the timestamp of the last probe ATTEMPT, so an operator reading
    // `docker logs` can judge exactly how fresh this batch_done line's
    // breaker reading is instead of inferring "sustained" from seeing the
    // same figure repeated across several lines.
    discogs_breaker_probe_at_ms: number | null;
  } => ({
    discogs_breaker_probe_outcome: breakerLatestOutcome,
    discogs_live_requests_total: breakerLastMeasurement?.liveRequestsTotal ?? null,
    discogs_req_per_min_measured: breakerLatestReqPerMin,
    discogs_breaker_probe_at_ms: breakerLastProbeAttemptAtMs,
  });

  // BS#895 review follow-up (finding #4): report the stranded-past-ceiling
  // count once at run start, before the self-heal pass or the main drain —
  // a cheap, single COUNT (see worklist.ts's docstring for the cost
  // rationale) that turns the recovery-window ceiling's silent exclusion
  // into an observable signal. Best-effort: a throw here must never abort
  // an otherwise-healthy run, mirroring `projectTotalsSpan`'s try/catch at
  // the end of this function.
  if (opts.countStrandedPastRecoveryWindow) {
    try {
      totals.stranded_past_recovery_window = await opts.countStrandedPastRecoveryWindow(recoveryWindowHours);
      if (totals.stranded_past_recovery_window > 0) {
        log(
          'warn',
          'stranded_past_recovery_window',
          `${totals.stranded_past_recovery_window} pending row(s) are older than the ` +
            `${recoveryWindowHours}h recovery-window ceiling and will never be swept until an operator ` +
            `widens BACKFILL_RECOVERY_WINDOW_HOURS or runs a dedicated catch-up pass`,
          {
            stranded_past_recovery_window: totals.stranded_past_recovery_window,
            recovery_window_hours: recoveryWindowHours,
          }
        );
        // Trend ("is this growing") is a Sentry-side concern (see the
        // `countStrandedPastRecoveryWindow` docstring) — this fires on every
        // non-zero run so the alert itself can apply anomaly-detection /
        // rate-of-change rules against the numeric span attribute rather
        // than this stateless cron trying to remember the last run's count.
        Sentry.captureMessage(`${JOB_NAME}.stranded_past_recovery_window`, {
          level: 'warning',
          tags: { step: 'stranded_past_recovery_window' },
          extra: {
            stranded_past_recovery_window: totals.stranded_past_recovery_window,
            recovery_window_hours: recoveryWindowHours,
          },
        });
      }
    } catch (error) {
      log('warn', 'stranded_past_recovery_window_failed', 'countStrandedPastRecoveryWindow threw; continuing run', {
        error_message: error instanceof Error ? error.message : String(error),
      });
      captureError(error, 'stranded_past_recovery_window_failed');
    }
  }

  // Cooperative pause (#735): yield whenever a DJ is actively touching the
  // playout. Gates the self-heal pass, the work-list build (itself a heavy
  // read), and every batch slice.
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

  // W4 self-heal (BS#895 / epic #1810), gated on `opts.buildSelfHealCandidates`
  // being provided. Runs BEFORE the main pending drain: it's a tiny,
  // high-value correction (rotation rows that just got a resolved Discogs
  // id) that shouldn't be starved by a busy main-sweep night.
  if (opts.buildSelfHealCandidates) {
    await waitForQuietBooth();
    const selfHealEnrich: EnrichFn =
      opts.selfHealEnrich ??
      ((row, response) => defaultApplyEnrichment(row, response, { fromStatus: 'enriched_no_match' }));
    const selfHealStampDeadLetter: StampDeadLetterFn =
      opts.selfHealStampDeadLetter ?? ((rowId) => defaultStampDeadLetter(rowId, { fromStatus: 'enriched_no_match' }));

    const selfHealIds = await opts.buildSelfHealCandidates();
    totals.self_heal_candidates = selfHealIds.length;

    if (selfHealIds.length > 0) {
      log(
        'info',
        'self_heal_candidates_found',
        `W4 self-heal: ${selfHealIds.length} rotation-linked no-match row(s) to re-attempt`,
        { self_heal_candidates: selfHealIds.length }
      );

      let selfHealCursor = 0;
      while (selfHealCursor < selfHealIds.length) {
        await waitForQuietBooth();
        const sliceEnd = Math.min(selfHealCursor + batchSize, selfHealIds.length);
        const sliceIds = selfHealIds.slice(selfHealCursor, sliceEnd);
        selfHealCursor = sliceEnd;

        const rows = await loadSelfHealRowsByIds(sliceIds);
        const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
        const orderedRows = sliceIds.flatMap((id) => {
          const row = rowsById.get(id);
          return row ? [row] : [];
        });
        // BS#895 review follow-up (finding #5a): mirrors the main loop's
        // `stale_skipped += sliceIds.length - orderedRows.length` — an id
        // the candidate query returned that vanished by load time (a
        // concurrent overlapping run already re-attempted it; terminal
        // `enriched_no_match` rows are never claimed by the CDC worker, so
        // that's the only realistic cause here). Keeps the self-heal
        // cohort reconciling: `self_heal_candidates == self_heal_skipped +
        // self_heal_scanned`.
        totals.self_heal_skipped += sliceIds.length - orderedRows.length;

        for (const row of orderedRows) {
          // BS#1995 Arm 2 (review B1): checked per row, not per batch —
          // see `waitForClosedBreaker`'s doc comment for why the batch
          // boundary is too coarse a clock at this job's own recommended
          // catch-up rate.
          await waitForClosedBreaker();
          const { outcome, cacheHit } = await processRow(row, {
            lookup: opts.lookup,
            enrich: selfHealEnrich,
            stampDeadLetter: selfHealStampDeadLetter,
          });
          // BS#895 review follow-up (finding #5b): self-heal outcomes route
          // to their OWN counters, never the shared `scanned` /
          // `enriched_match` / `enriched_no_match` / `lml_error` /
          // `enrich_error` buckets above — see the Totals doc for why
          // blending would silently inflate the main sweep's dashboard
          // signal.
          totals.self_heal_scanned += 1;
          if (outcome === 'enriched_match' || outcome === 'enriched_match_raced') {
            totals.self_heal_resolved += 1;
          } else if (outcome === 'enriched_no_match' || outcome === 'enriched_no_match_raced') {
            totals.self_heal_no_match += 1;
          } else if (outcome === 'lml_error') {
            totals.self_heal_lml_error += 1;
          } else if (outcome === 'upstream_unavailable_skipped') {
            // BS#1995 Arm 3: same refusal-to-write classification as the
            // main sweep, its own bucket for the same reason every other
            // self_heal_* counter is separate — see the doc above.
            totals.self_heal_upstream_unavailable_skipped += 1;
          } else {
            totals.self_heal_enrich_error += 1;
          }
          if (throttleMs > 0 && !cacheHit) await sleep(throttleMs);
        }
      }

      log(
        'info',
        'self_heal_done',
        `W4 self-heal pass done: ${totals.self_heal_resolved}/${totals.self_heal_candidates} resolved`,
        {
          self_heal_candidates: totals.self_heal_candidates,
          self_heal_skipped: totals.self_heal_skipped,
          self_heal_scanned: totals.self_heal_scanned,
          self_heal_resolved: totals.self_heal_resolved,
          self_heal_no_match: totals.self_heal_no_match,
          self_heal_lml_error: totals.self_heal_lml_error,
          self_heal_enrich_error: totals.self_heal_enrich_error,
          self_heal_upstream_unavailable_skipped: totals.self_heal_upstream_unavailable_skipped,
        }
      );
    }
  }

  await waitForQuietBooth();
  const buildStart = Date.now();
  const workList = await buildList({
    playFloor,
    recencyDays: floorRecencyDays,
    partitionFilter: partition.sqlFragment,
    graceMinutes,
    recoveryWindowHours,
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
  // `metadata_status = 'pending'` for the next run — can never be
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
      // BS#1995 Arm 2 (review B1): checked per row, not per batch — see
      // `waitForClosedBreaker`'s doc comment for why the batch boundary is
      // too coarse a clock at this job's own recommended catch-up rate.
      await waitForClosedBreaker();
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
    const breakerFields = readBreakerFields();

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      worklist_cursor: cursor,
      batch_plays_max: batchPlaysMax,
      batch_plays_min: batchPlaysMin,
      ...totals,
      ...cacheFields,
      ...breakerFields,
    });
  }

  const finalCacheFields = readCacheFields(opts.cacheStats);
  const finalBreakerFields = readBreakerFields();
  log('info', 'finished', `${JOB_NAME} done. ${formatTotals(totals)}`, {
    ...totals,
    ...finalCacheFields,
    ...finalBreakerFields,
  });

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
