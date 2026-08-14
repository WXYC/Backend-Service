/**
 * One-shot orchestrator for the flowsheet-reenrichment drain (BS#1433).
 *
 * Iterates flowsheet rows matching:
 *   metadata_status = 'enriched_no_match'
 *   AND album_id IS NULL
 *   AND artist_name IS NOT NULL
 *   AND add_time < $BACKFILL_CUTOFF_TS        (optional upper bound)
 *   AND add_time >= $BACKFILL_WINDOW_START_TS  (optional lower bound, BS#1823)
 *   AND updated_at >= $BACKFILL_UPDATED_AFTER_TS  (optional, BS#1998)
 *   AND updated_at < $BACKFILL_UPDATED_BEFORE_TS  (optional, BS#1998)
 *
 * BS#1823 added the optional BACKFILL_WINDOW_START_TS lower bound so the
 * same drain can re-enrich a recent, bounded slice of the backlog (e.g. the
 * B3 regression window, LML#920) instead of only the original pre-LML#583
 * cohort. Cutoff-only preserves the original behavior exactly;
 * window-start-only applies no upper bound (through "now", in effect).
 *
 * BS#1998 added the `updated_at` pair as a second, independent axis. The
 * 2026-08-03/04 LML breaker flap terminalized 26,387 rows while this drain's
 * sibling was working the historical backlog, so those victims span the
 * whole `add_time` range and cannot be selected by it at all — the only
 * thing they share is WHEN they were frozen. At least one of the four
 * bounds is required; see `resolveTimeWindow`.
 *
 * Why an `updated_at` window is stable despite selecting on a mutable
 * column: this job's no-match arm writes nothing (`enrich.ts` change 2), so
 * `updated_at` moves only for rows that simultaneously leave the cohort via
 * `metadata_status='enriched_match'`. The predicate does not eat its own
 * tail, and no id-freeze artifact is needed. The one leak is an UNRELATED
 * writer touching a cohort row mid-run, which evicts it — see the README.
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
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  resolveLiveActivityMaxPauseMs as resolveLiveActivityMaxPauseMsShared,
  buildWaitForQuietPeriod,
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
 * Shared strict ISO 8601 + calendar validator for the drain's two boundary
 * env vars (BACKFILL_CUTOFF_TS, BACKFILL_WINDOW_START_TS — BS#1823).
 * Extracted from resolveCutoffTs's original inline checks so
 * BACKFILL_WINDOW_START_TS can't drift from BACKFILL_CUTOFF_TS's exact
 * strictness. Throws using `envName` in the message so each caller's
 * errors stay field-specific despite sharing one validation path.
 *
 * Catches Date.parse-passes-but-PG-rejects inputs like '2026-6-16',
 * '2026/06/16', '2026', '6/16/2026'. Also enforces calendar-field bounds
 * (irrespective of TZ) so normalized out-of-range days (e.g. '2026-02-30'
 * → '2026-03-02') are rejected even though Date.parse accepts them.
 *
 * Returns the Date.parse'd epoch ms so a caller needing a future-timestamp
 * check (only resolveCutoffTs does — see BS#1823's decision that a future
 * window-start is valid, not an error) doesn't need to re-parse.
 */
const validateStrictIso8601 = (raw: string, envName: string): number => {
  if (!ISO_8601_RE.test(raw)) {
    throw new Error(
      `${envName}=${JSON.stringify(raw)} is not strict ISO 8601 (e.g. 2026-06-16T17:53:53Z or 2026-06-16T10:53:53-07:00).`
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
    throw new Error(`${envName}=${JSON.stringify(raw)} has an out-of-range field (calendar / 24h validation failed).`);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${envName}=${JSON.stringify(raw)} is not a parseable timestamp.`);
  }
  return parsed;
};

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
  const parsed = validateStrictIso8601(raw, 'BACKFILL_CUTOFF_TS');
  if (parsed > Date.now()) {
    throw new Error(
      `BACKFILL_CUTOFF_TS=${JSON.stringify(raw)} is in the future; cohort would include legitimately-terminal post-fix rows. Use the LML#583 merge timestamp.`
    );
  }
  return raw;
};

/**
 * Optional lower-bound companion to resolveCutoffTs (BS#1823 — scoped
 * re-enrichment of a recent regression-backlog window). Mirrors its strict
 * ISO 8601 + calendar validation exactly (shared via validateStrictIso8601),
 * but differs in two ways:
 *
 *   - Unset is valid: returns undefined (the caller applies no lower
 *     bound), since this bound is optional wherever BACKFILL_CUTOFF_TS is
 *     supplied instead — see resolveTimeWindow for the "at least one of
 *     the two" rule.
 *   - A future timestamp is NOT rejected. A window start staged ahead of
 *     time simply selects nothing until that instant arrives — a valid
 *     (if inert) configuration, unlike a future cutoff (which would widen
 *     the cohort to include legitimately-terminal post-fix rows).
 */
export const resolveWindowStartTs = (
  raw: string | undefined = process.env.BACKFILL_WINDOW_START_TS
): string | undefined => {
  if (!raw) return undefined;
  validateStrictIso8601(raw, 'BACKFILL_WINDOW_START_TS');
  return raw;
};

/**
 * BS#1998: bounds on `updated_at`, the instant a row was last written.
 *
 * The add_time pair above cannot express the BS#1998 cohort. The
 * 2026-08-03/04 LML breaker flap terminalized 26,387 rows while the
 * historical drain was working the pre-2026 backlog, so the victims span
 * `add_time` 2004→2026 — the entire table. What they share is *when they
 * were frozen*, which only `updated_at` records.
 *
 * Validated identically to the add_time pair (strict ISO 8601 + calendar
 * bounds). A future value is allowed on the LOWER bound, where it simply
 * selects nothing. The UPPER bound is not symmetric — see
 * `assertWindowShape`, which rejects it outright when it stands alone.
 *
 * Shared implementation rather than three near-identical copies (review
 * round 1): the original two-copy shape is what let `job.ts`'s pre-flight
 * list drift from `resolveTimeWindow`'s in the first place, and cloning it
 * a third time would guarantee the next optional-bound change lands in only
 * some of them.
 */
const resolveOptionalIso8601 = (raw: string | undefined, envName: string): string | undefined => {
  if (!raw) return undefined;
  validateStrictIso8601(raw, envName);
  return raw;
};

export const resolveUpdatedAfterTs = (
  raw: string | undefined = process.env.BACKFILL_UPDATED_AFTER_TS
): string | undefined => resolveOptionalIso8601(raw, 'BACKFILL_UPDATED_AFTER_TS');

export const resolveUpdatedBeforeTs = (
  raw: string | undefined = process.env.BACKFILL_UPDATED_BEFORE_TS
): string | undefined => resolveOptionalIso8601(raw, 'BACKFILL_UPDATED_BEFORE_TS');

/**
 * Two shape assertions on the `updated_at` pair, both closing ways an
 * operator typo silently becomes a catastrophic or vacuous run (review
 * round 1).
 *
 * 1. **An upper bound may not stand alone.** `updated_at < X` with no lower
 *    bound is not a narrow window — it is "every unlinked no-match row this
 *    table has ever held," since essentially all of them were last written
 *    before any plausible X. That is the unbounded sweep `resolveTimeWindow`
 *    already declares was never an intended run shape, and at TB(20/min) it
 *    would be days of Discogs calls: the same over-broad-drain shape as the
 *    incident this job now exists to repair. The `add_time` axis has no
 *    equivalent hazard — `add_time < cutoff` IS the original BS#1433 cohort
 *    — which is why the rule binds only this pair.
 *
 * 2. **The bounds must be ordered.** A transposed pair validates fine
 *    individually and yields an empty intersection, so the run reports
 *    `scanned: 0` — the exact number the runbook tells the operator to
 *    record as the frozen cohort size. Silently reading "already drained"
 *    off a typo is worse than failing loudly.
 */
const assertWindowShape = (updatedAfterTs?: string, updatedBeforeTs?: string): void => {
  if (updatedBeforeTs && !updatedAfterTs) {
    throw new Error(
      'BACKFILL_UPDATED_BEFORE_TS was set without BACKFILL_UPDATED_AFTER_TS. An upper bound alone selects the entire unlinked enriched_no_match backlog, not a window; set the lower bound too.'
    );
  }
  if (updatedAfterTs && updatedBeforeTs && Date.parse(updatedAfterTs) >= Date.parse(updatedBeforeTs)) {
    throw new Error(
      `BACKFILL_UPDATED_AFTER_TS (${updatedAfterTs}) must be strictly before BACKFILL_UPDATED_BEFORE_TS (${updatedBeforeTs}); the window as given selects nothing.`
    );
  }
};

export type TimeWindow = {
  cutoffTs?: string;
  windowStartTs?: string;
  updatedAfterTs?: string;
  updatedBeforeTs?: string;
};

/**
 * Resolves the drain's cohort time-window from BACKFILL_CUTOFF_TS /
 * BACKFILL_WINDOW_START_TS / BACKFILL_UPDATED_AFTER_TS /
 * BACKFILL_UPDATED_BEFORE_TS (or explicit overrides — see runReenrichment's
 * opts). At least one bound is required: a drain with none has no
 * defined cohort (an unbounded sweep of the entire enriched_no_match
 * backlog was never an intended run shape).
 *
 *   - Cutoff-only reproduces resolveCutoffTs's exact original behavior
 *     (required-if-called-alone semantics live in resolveCutoffTs itself;
 *     here it's simply invoked when cutoffRaw is present).
 *   - Window-start-only is a valid open-ended "everything from X to now"
 *     run — no upper bound is applied.
 *   - Both set narrows to the intersection (a bounded window).
 *
 * BS#1998 added the `updated_at` pair as an INDEPENDENT axis, not a
 * replacement: the two pairs intersect when both are supplied, and either
 * pair alone satisfies the at-least-one requirement. The BS#1998 run shape
 * uses the updated_at pair alone.
 */
/**
 * The complete set of cohort-bound env vars, exported so `job.ts`'s
 * pre-flight existence check can't drift from what `resolveTimeWindow`
 * actually accepts. That drift is precisely the bug BS#1998 had to fix:
 * `job.ts` listed only the two add_time bounds and rejected the updated_at
 * run shape before the drain ever reached this function. One list, two
 * readers.
 */
export const TIME_WINDOW_ENV_VARS = [
  'BACKFILL_CUTOFF_TS',
  'BACKFILL_WINDOW_START_TS',
  'BACKFILL_UPDATED_AFTER_TS',
  'BACKFILL_UPDATED_BEFORE_TS',
] as const;

export const resolveTimeWindow = (
  cutoffRaw: string | undefined = process.env.BACKFILL_CUTOFF_TS,
  windowStartRaw: string | undefined = process.env.BACKFILL_WINDOW_START_TS,
  updatedAfterRaw: string | undefined = process.env.BACKFILL_UPDATED_AFTER_TS,
  updatedBeforeRaw: string | undefined = process.env.BACKFILL_UPDATED_BEFORE_TS
): TimeWindow => {
  if (!cutoffRaw && !windowStartRaw && !updatedAfterRaw && !updatedBeforeRaw) {
    throw new Error(`At least one of ${TIME_WINDOW_ENV_VARS.join(', ')} is required; none is set.`);
  }
  const cutoffTs = cutoffRaw ? resolveCutoffTs(cutoffRaw) : undefined;
  const windowStartTs = resolveWindowStartTs(windowStartRaw);
  const updatedAfterTs = resolveUpdatedAfterTs(updatedAfterRaw);
  const updatedBeforeTs = resolveUpdatedBeforeTs(updatedBeforeRaw);
  assertWindowShape(updatedAfterTs, updatedBeforeTs);
  return { cutoffTs, windowStartTs, updatedAfterTs, updatedBeforeTs };
};

/**
 * BS#1998: opt-in scope preview. `DRY_RUN=true` walks the cohort with the
 * real SELECT — same predicate, same paging, same cooperative pause — but
 * calls neither LML nor `enrich`, so the run costs nothing and writes
 * nothing. The `scanned` total it reports IS the cohort count, which the
 * BS#1998 runbook records before authorizing a live run.
 *
 * Deliberately opt-IN rather than dry-run-by-default. This job has been an
 * immediately-writing operational tool since BS#1433 and its README's run
 * recipes (and BS#1823's) assume that; flipping the default would silently
 * turn a re-run of either documented recipe into a no-op, which is a worse
 * failure than the one dry-run-by-default protects against.
 *
 * Truthy values are `true` / `1`, falsey are `false` / `0`, both
 * case-insensitive and whitespace-trimmed — the locked set `docs/env-vars.md`
 * documents for every other `DRY_RUN` in the fleet (`album-reviews-etl`,
 * `library-identity-consumer`, `rotation-release-id-backfill`, …). Accepting
 * only `true`/`false` here (review round 1) would have made `-e DRY_RUN=1`
 * — muscle memory from any of those jobs — abort with a Sentry-captured
 * `failed` line, reading as a crash rather than a flag-format complaint.
 *
 * Anything OUTSIDE that set still throws rather than falling back to "live":
 * a typo'd `DRY_RUN` that writes when the operator believed it was
 * previewing is the failure worth being loud about.
 */
export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined || raw === '') return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`DRY_RUN=${JSON.stringify(raw)} is not a boolean; use "true"/"1" or "false"/"0".`);
};

/**
 * BS#1998 review round 1: consecutive-shed abort threshold. `0` disables.
 * Default 25 — comfortably above any plausible transient blip at this job's
 * TB(20/min) pacing (~75 s of shedding), well below the point where the run
 * has wasted meaningful budget on an upstream that cannot answer.
 */
export const MAX_CONSECUTIVE_SHEDS = 25;

export const resolveMaxConsecutiveSheds = (
  raw: string | undefined = process.env.BACKFILL_MAX_CONSECUTIVE_SHEDS
): number =>
  requireNonNegativeInt(raw, 'BACKFILL_MAX_CONSECUTIVE_SHEDS', MAX_CONSECUTIVE_SHEDS, {
    note: 'Use 0 to disable the consecutive-shed abort.',
  });

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable the cooperative pause.',
  });

/**
 * BS#2147: delegates to the shared floored resolver so `LIVE_ACTIVITY_PAUSE_MS`
 * below `LIVE_ACTIVITY_MIN_PAUSE_MS` (including `0`) is rejected at init
 * instead of degrading the cooperative-pause loop into a hot loop against
 * RDS. `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` remains the sole disable knob.
 */
export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  resolveLiveActivityPauseMsShared(raw, 'LIVE_ACTIVITY_PAUSE_MS');

/**
 * BS#2147 review round 2, finding 5: wires `LIVE_ACTIVITY_MAX_PAUSE_MS` at
 * this job's own call site. Before this, `buildWaitForQuietPeriod`'s
 * `maxTotalPauseMs` always took its hardcoded 30-minute default — the env
 * var read like a tunable knob but no TypeScript job ever read it, the
 * exact failure shape BS#2147 exists to close. `0` = uncapped.
 */
export const resolveLiveActivityMaxPauseMs = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_MAX_PAUSE_MS
): number => resolveLiveActivityMaxPauseMsShared(raw, LIVE_ACTIVITY_MAX_PAUSE_MS_ENV);

export type LookupResult = { response: LookupResponse; cacheHit: boolean };
export type LookupFn = (artist: string, album?: string, track?: string) => Promise<LookupResult>;
export type EnrichFn = (row: ReenrichRow, response: LookupResponse) => Promise<ReenrichOutcome>;

export type Totals = {
  scanned: number;
  match: number;
  match_raced: number;
  still_no_match: number;
  /**
   * BS#1998: rows LML was never able to ask Discogs about (breaker shed, or
   * the BS#1748 client-side limiter shed). Held apart from `still_no_match`
   * because only the latter is a verdict — see `enrich.ts`'s guard. A
   * non-zero count means the run under-covered its cohort and should be
   * re-run once LML is healthy; the rows themselves are untouched and stay
   * selectable.
   */
  upstream_unavailable_skipped: number;
  lml_error: number;
  db_error: number;
};

export type RunResult = {
  totals: Totals;
  flipped: number;
  /** BS#1998: true when DRY_RUN suppressed every LML call and every write. */
  dryRun: boolean;
  stopped: boolean;
  /**
   * True iff the run terminated via the failed-step path (uncaught loop
   * exception or loadBatch retry exhaustion). Used by job.ts main() to
   * set process.exitCode=1 — without this, the container would exit 0
   * on sustained RDS outage because runReenrichment now catches its own
   * exceptions to preserve the summary log. The structured log carries
   * the error_message; this field is the boolean shortcut for the
   * wrapping script's `$?` check.
   */
  failed: boolean;
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

/**
 * Optional-bound composition (BS#1823): each clause is included only when
 * its bound is set, mirroring the `cond ? sql\`AND ...\` : sql\`\`` pattern
 * used elsewhere in this codebase for dynamic WHERE clauses (e.g.
 * apps/backend/services/library.service.ts's streamingClause,
 * jobs/flowsheet-metadata-backfill/worklist.ts's partitionFilter). At least
 * one of cutoffTs/windowStartTs is always set by the time this is called
 * (resolveTimeWindow enforces it), but both branches degrade to `sql\`\``
 * (a no-op fragment) when their bound is absent, so this function itself
 * doesn't need to re-assert that invariant.
 */
const loadBatchOnce = async (afterId: number, batchSize: number, window: TimeWindow): Promise<ReenrichRow[]> => {
  const { cutoffTs, windowStartTs, updatedAfterTs, updatedBeforeTs } = window;
  const cutoffClause = cutoffTs ? sql`AND "add_time" < ${cutoffTs}::timestamptz` : sql``;
  const windowStartClause = windowStartTs ? sql`AND "add_time" >= ${windowStartTs}::timestamptz` : sql``;
  // BS#1998: the incident-cohort axis. Independent of the add_time pair —
  // both compose, and either pair alone is a valid run shape.
  const updatedAfterClause = updatedAfterTs ? sql`AND "updated_at" >= ${updatedAfterTs}::timestamptz` : sql``;
  const updatedBeforeClause = updatedBeforeTs ? sql`AND "updated_at" < ${updatedBeforeTs}::timestamptz` : sql``;
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
      ${cutoffClause}
      ${windowStartClause}
      ${updatedAfterClause}
      ${updatedBeforeClause}
      AND "id" > ${afterId}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as ReenrichRow[];
  return rows ?? [];
};

/**
 * loadBatch with transient-error retry. Honors stopRequested so shutdown
 * isn't blocked by retry backoffs. Exhausting retries throws the most
 * recent error.
 *
 * Stop-during-retry signaling: caller distinguishes a stop-triggered exit
 * from a real failure by checking the module-level `stopRequested` flag
 * — no custom sentinel needed, since the flag was true at throw time and
 * stays true until __resetStopForTesting (production never resets it).
 */
const loadBatch = async (afterId: number, batchSize: number, window: TimeWindow): Promise<ReenrichRow[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadBatchOnce(afterId, batchSize, window);
    } catch (error) {
      lastError = error;
      if (stopRequested || attempt + 1 >= LOAD_BATCH_MAX_ATTEMPTS) throw error;
      const backoff = LOAD_BATCH_BACKOFF_MS[attempt] ?? LOAD_BATCH_BACKOFF_MS[LOAD_BATCH_BACKOFF_MS.length - 1];
      log('warn', 'load_batch_retry', `loadBatch attempt ${attempt + 1} failed; retrying in ${backoff}ms`, {
        attempt: attempt + 1,
        after_id: afterId,
        backoff_ms: backoff,
        error_message: errorMessage(error),
      });
      await stopAwareSleep(backoff);
      if (stopRequested) throw error;
    }
  }
  // Unreachable: the loop above either returns or throws. The throw exists
  // for TS narrowing — without it the function's return type widens.
  throw lastError;
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
  windowStartTs?: string;
  updatedAfterTs?: string;
  updatedBeforeTs?: string;
  dryRun?: boolean;
  maxConsecutiveSheds?: number;
  batchSize?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  /** Cumulative cooperative-pause budget ceiling; 0 = uncapped. */
  liveActivityMaxPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
}): Promise<RunResult> => {
  // BS#1823: resolveTimeWindow enforces "at least one bound" and applies
  // each bound's own validation (cutoff: required-if-alone +
  // future-rejection; the other three: optional + future-allowed). Explicit
  // opts pass through the same validation as env-sourced values — a
  // caller-supplied override is no longer a silent bypass.
  const window = resolveTimeWindow(opts.cutoffTs, opts.windowStartTs, opts.updatedAfterTs, opts.updatedBeforeTs);
  const { cutoffTs, windowStartTs, updatedAfterTs, updatedBeforeTs } = window;
  const dryRun = opts.dryRun ?? resolveDryRun();
  const maxConsecutiveSheds = opts.maxConsecutiveSheds ?? resolveMaxConsecutiveSheds();
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const liveActivityMaxPauseMs = opts.liveActivityMaxPauseMs ?? resolveLiveActivityMaxPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;
  // Hoist deps outside the per-row loop — one object reused for ~12k rows.
  const deps = { lookup: opts.lookup, enrich: opts.enrich };

  // BS#2147: the loop itself (probe + fail-open + stop-awareness + elapsed-
  // time cap) now lives in the shared `buildWaitForQuietPeriod`. `onPause`
  // and `onProbeError` reproduce this job's exact prior log lines/fields so
  // ops greps against `live_activity_pause`/`probe_error` don't drift.
  // `liveActivityMaxPauseMs` (finding 5) is wired so
  // `LIVE_ACTIVITY_MAX_PAUSE_MS` actually reaches `maxTotalPauseMs`; on
  // exhaustion the closure throws (findings 1+2) and — since this job's
  // outer block is try/finally with no catch of its own — that error
  // propagates out of `runReenrichment` as a rejection after the finally
  // arm still emits the summary log/span with the resume cursor.
  const waitForQuietPeriodImpl = buildWaitForQuietPeriod({
    lookbackSeconds: liveActivityLookbackSeconds,
    pauseMs: liveActivityPauseMs,
    maxTotalPauseMs: liveActivityMaxPauseMs,
    probe,
    shouldStop: () => stopRequested,
    onPause: () => {
      log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
        lookback_seconds: liveActivityLookbackSeconds,
        pause_ms: liveActivityPauseMs,
      });
    },
    onProbeError: (error) => {
      log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
        error_message: errorMessage(error),
      });
      captureError(error, 'probe_error');
    },
    onBudgetExhausted: (pausedMs) => {
      log(
        'error',
        'live_activity_pause_ceiling_exceeded',
        `cooperative-pause budget exceeded (${pausedMs}ms >= LIVE_ACTIVITY_MAX_PAUSE_MS=${liveActivityMaxPauseMs}ms); aborting instead of pausing indefinitely`,
        { paused_ms: pausedMs, live_activity_max_pause_ms: liveActivityMaxPauseMs, last_id: lastId }
      );
    },
  });

  // BS#1998 review round 1: a dry run reads nothing a DJ contends with and
  // writes nothing at all, so deferring it to a quiet period buys no safety
  // and can strand a scope preview in `live_activity_pause` for the length
  // of a show — right when the operator is trying to size the run. Kept at
  // the call site (not inside the shared helper) since it's specific to
  // this job's dry-run semantics.
  const waitForQuietPeriod = async (): Promise<boolean> => {
    if (dryRun) return stopRequested;
    return waitForQuietPeriodImpl();
  };

  log('info', 'started', `${JOB_NAME} starting`, {
    cutoff_ts: cutoffTs ?? null,
    window_start_ts: windowStartTs ?? null,
    updated_after_ts: updatedAfterTs ?? null,
    updated_before_ts: updatedBeforeTs ?? null,
    dry_run: dryRun,
    max_consecutive_sheds: maxConsecutiveSheds,
    batch_size: batchSize,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
    live_activity_max_pause_ms: liveActivityMaxPauseMs,
  });

  const totals: Totals = {
    scanned: 0,
    match: 0,
    match_raced: 0,
    still_no_match: 0,
    upstream_unavailable_skipped: 0,
    lml_error: 0,
    db_error: 0,
  };
  const matchRacedIds: number[] = [];
  let matchRacedTruncatedCount = 0;
  let consecutiveSheds = 0;
  let lastId = 0;
  let batchIndex = 0;
  let stopped = false;
  let failed: { error: unknown } | null = null;
  const flipped = (): number => totals.match;

  try {
    while (true) {
      if (stopRequested || (await waitForQuietPeriod())) {
        stopped = true;
        break;
      }

      let rows: ReenrichRow[];
      try {
        rows = await loadBatch(lastId, batchSize, window);
      } catch (error) {
        // Distinguish stop-triggered exit from real failure via the same
        // module flag the inner retry observed. No custom sentinel class
        // — just read the flag the SIGTERM handler set.
        if (stopRequested) {
          stopped = true;
        } else {
          // Sustained DB outage exhausted the retry budget. Capture so the
          // finally arm still emits the summary span + log with last_id,
          // enabling resume-from-last_id from the structured logs.
          failed = { error };
        }
        break;
      }
      if (rows.length === 0) break;

      batchIndex += 1;
      const batchStart = Date.now();
      // Snapshot totals before the batch so per-batch counters can be
      // derived without a parallel batchTotals object (round 3 cleanup).
      const before = { ...totals };

      for (const row of rows) {
        // BS#1998 dry run: count the row and move on. The scan is the whole
        // deliverable — no LML call, no enrich call, no write.
        if (dryRun) {
          totals.scanned += 1;
          lastId = row.id;
          if (stopRequested) {
            stopped = true;
            break;
          }
          continue;
        }
        const outcome = await processRow(row, deps);
        totals.scanned += 1;
        totals[outcome] += 1;
        if (outcome === 'match_raced') {
          if (matchRacedIds.length < MATCH_RACED_SAMPLE) matchRacedIds.push(row.id);
          else matchRacedTruncatedCount += 1;
        }
        lastId = row.id;

        // BS#1998 review round 1: abort when LML is shedding every request.
        //
        // Classifying a shed (enrich.ts) stops it corrupting the verdict, but
        // on its own it does nothing to stop the run. With the breaker open,
        // every row returns a shed, and the drain would issue 26k real HTTP
        // lookups over ~22h against an LML that cannot answer one of them,
        // then report `upstream_unavailable_skipped: 26323` and ask the
        // operator to start over. That is a lot of load applied to an
        // already-unhealthy upstream to accomplish nothing.
        //
        // Deliberately NOT a port of the sibling's `/health` breaker gate
        // (`jobs/flowsheet-metadata-backfill/lml-health.ts`). That gate probes
        // an endpoint whose Discogs check short-circuits ONLY while the
        // breaker is non-closed — so on the healthy path, which is ~every run,
        // each probe spends a live Discogs call from the very ceiling it
        // exists to protect. Counting the sheds we already have in hand costs
        // nothing, needs no new dependency, and reacts to the condition itself
        // rather than to a proxy for it.
        //
        // Reset on ANY other outcome (including `still_no_match` and
        // `lml_error`): the trigger is a SUSTAINED all-shed streak, not
        // cumulative sheds — a breaker flapping in and out still lets real
        // work through, and that run should continue.
        if (outcome === 'upstream_unavailable_skipped') {
          consecutiveSheds += 1;
          if (maxConsecutiveSheds > 0 && consecutiveSheds >= maxConsecutiveSheds) {
            failed = {
              error: new Error(
                `LML shed ${consecutiveSheds} consecutive lookups (BACKFILL_MAX_CONSECUTIVE_SHEDS=${maxConsecutiveSheds}); aborting rather than burning the cohort against an open breaker. No rows were written by the shed responses; re-run once LML is healthy.`
              ),
            };
            break;
          }
        } else {
          consecutiveSheds = 0;
        }
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
        upstream_unavailable_skipped: totals.upstream_unavailable_skipped - before.upstream_unavailable_skipped,
        lml_error: totals.lml_error - before.lml_error,
        db_error: totals.db_error - before.db_error,
        flipped: totals.match - before.match,
        // Cumulative scanned for progress monitoring.
        total_scanned: totals.scanned,
      });

      // `failed` is checked alongside `stopped` because the shed-abort above
      // sets it from inside the per-row loop, where `break` only leaves that
      // loop — without this the run would log the abort and then calmly fetch
      // the next batch, which is the opposite of aborting.
      if (stopped || failed) break;
    }
  } catch (error) {
    // BS#2147 review round 2, finding "flowsheet-reenrichment logs a success
    // summary on a ceiling abort": the cooperative-pause budget ceiling
    // throws LiveActivityPauseCeilingExceededError out of waitForQuietPeriod()
    // above — a new escape path this loop didn't have before. Without this
    // catch, `failed` stays at its null default and the finally arm below
    // logs step='finished' / failed:false, contradicting its own contract
    // comment ("'failed' — uncaught exception"). Set `failed` before
    // rethrowing so the finally arm's step/level/captureError all read the
    // abort correctly; the rethrow preserves the existing
    // rejects-with-LiveActivityPauseCeilingExceededError contract.
    failed = { error };
    throw error;
  } finally {
    // Summary span carrying numeric attributes (BS#1081 typing-trap workaround).
    // Always emitted — even on stop/fail — so partial-run telemetry is
    // available in Sentry trace explorer.
    Sentry.startSpan(
      {
        name: 'reenrichment.run.summary',
        attributes: {
          'reenrichment.flipped_count': flipped(),
          'reenrichment.still_no_match_count': totals.still_no_match,
          'reenrichment.upstream_unavailable_skipped_count': totals.upstream_unavailable_skipped,
          // Without this a dry run's span is byte-identical to a live run
          // that matched nothing — the catastrophic outcome the span exists
          // to surface (review round 1).
          'reenrichment.dry_run': dryRun,
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
      flipped: flipped(),
      dry_run: dryRun,
      last_id: lastId,
      stopped,
      failed: failed !== null,
      ...(failed ? { error_message: errorMessage(failed.error) } : {}),
    });
    if (failed) {
      captureError(failed.error, 'failed', { last_id: lastId, scanned: totals.scanned, flipped: flipped() });
    }
  }
  return { totals, flipped: flipped(), dryRun, stopped, failed: failed !== null };
};
