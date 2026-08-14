/**
 * jobs/flowsheet-april-gap-import (BS#2119): import the closed BS#351
 * residue — flowsheet entries tubafrenzy holds that Backend never received
 * because the pre-fix incremental sync silently dropped every track entry
 * with `START_TIME = 0` (the normal state for track entries; only
 * show_start/show_end markers carry a non-zero START_TIME). Fixed forward
 * 2026-04-20; nothing still produces this shape. Default scope is the
 * unambiguous 399-row / 15-show April window — see window.ts and the job
 * README for why the 4 post-Phase-3 August rows are deliberately excluded
 * from the default.
 *
 * Insert-only, `ON CONFLICT (legacy_entry_id) DO NOTHING` — never `DO
 * UPDATE`. Every id in the cohort is absent from Backend by construction (the
 * discovery pass below computes the set difference), so a pure INSERT
 * touches no Backend-canonical row. `DO NOTHING` (rather than relying on the
 * pre-computed missing-set alone) absorbs live churn between the discovery
 * read and the write, and a re-run of this job entirely: the attempted set
 * and the inserted set can differ, which is why every batch uses `RETURNING
 * legacy_entry_id` — the operator's rollback record is what actually landed,
 * not what was attempted.
 *
 * Column mapping and `dj_name`/`album_id` pre-resolution live in
 * build-row.ts (pure) and the read-only SELECTs below. `dj_name` goes through
 * the canonical `resolveShowDjName` (`@wxyc/database` dj-name.ts), never a
 * re-derived COALESCE. It is deliberately NOT resolved via
 * jobs/flowsheet-etl/job.ts's `resolveDjNames` — that helper is a post-insert
 * `UPDATE ... WHERE dj_name IS NULL`, which would violate insert-only and,
 * under `ON CONFLICT DO NOTHING`, could touch a pre-existing Backend row
 * whose `legacy_entry_id` happens to collide.
 *
 * Four refusals, all before any write and all active in dry-run too: an
 * upstream candidate floor (zero candidates is a bad window, not an empty
 * one — tubafrenzy rows don't depend on Backend state), a Backend-side floor
 * on `COUNT(legacy_entry_id)` (an undersized read means the read failed, not
 * that Backend is empty), a cohort ceiling (a missing-set larger than
 * expected is a comparison bug, not a discovery), and a NULL-key orphan guard
 * (a target show already holding non-marker rows with `legacy_entry_id IS
 * NULL` — invisible to both the diff and the conflict target, so importing
 * could duplicate a row a DJ already entered). Dry-run is the default;
 * `--execute` writes. Batched inserts (~25/batch) with cooperative live-DJ
 * pause and an inter-batch gap, sized to keep the CDC enrichment worker's
 * shared LML rate limiter from bursting mid-show (BS#1748's TokenBucket is
 * process-wide, not per-caller).
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  flowsheet,
  library,
  shows,
  user,
  resolveShowDjName,
  intArrayLiteral,
  checkLiveActivity as defaultCheckLiveActivity,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  buildWaitForQuietPeriod,
  requireNonNegativeInt,
  requirePositiveInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import { fetchLegacyEntriesInWindow, type LegacyEntryRow } from '../flowsheet-etl/fetch-legacy.js';
import { buildShowIdMap as defaultBuildShowIdMap } from '../flowsheet-etl/show-id-map.js';
import { resolveEntryTimestamp } from '../flowsheet-etl/transform.js';
import { resolveWindow, type Window } from './window.js';
import { buildInsertRow, type GapImportRow } from './build-row.js';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'flowsheet-april-gap-import';

export const BATCH_SIZE_DEFAULT = 25;
export const BATCH_GAP_MS_DEFAULT = 30_000;
/** Undersized means the Backend-side read failed, not that Backend is empty. */
export const MIN_BACKEND_ID_COUNT_DEFAULT = 2_500_000;
/** Larger than this is a comparison bug, not a discovery — today's cohort is 403. */
export const MAX_COHORT_SIZE_DEFAULT = 2_000;
/** Fewer upstream candidates than this is a bad window, not an empty one. */
export const MIN_CANDIDATE_COUNT_DEFAULT = 1;
/**
 * Any non-marker NULL-`legacy_entry_id` row in a target show is an
 * insert-only hazard the conflict target cannot cover — refuse by default.
 */
export const MAX_NULL_KEY_ROWS_DEFAULT = 0;

// ---- CLI / env resolution ----

export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveBatchSize = (raw: string | undefined = process.env.GAP_IMPORT_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'GAP_IMPORT_BATCH_SIZE', BATCH_SIZE_DEFAULT);

export const resolveBatchGapMs = (raw: string | undefined = process.env.GAP_IMPORT_BATCH_GAP_MS): number =>
  requireNonNegativeInt(raw, 'GAP_IMPORT_BATCH_GAP_MS', BATCH_GAP_MS_DEFAULT, {
    unit: 'ms',
    note: 'Use 0 to disable the inter-batch spacing.',
  });

export const resolveMinBackendIdCount = (
  raw: string | undefined = process.env.GAP_IMPORT_MIN_BACKEND_ID_COUNT
): number =>
  requireNonNegativeInt(raw, 'GAP_IMPORT_MIN_BACKEND_ID_COUNT', MIN_BACKEND_ID_COUNT_DEFAULT, {
    note: 'Refuses the run if the Backend-side legacy_entry_id count is below this. Use 0 to disable (tests only).',
  });

/**
 * Upstream floor, mirroring `resolveMinBackendIdCount`'s Backend-side one.
 * Zero candidates cannot be a legitimate outcome — discovery reads
 * tubafrenzy, whose rows do not depend on Backend state, so even a re-run of
 * a fully-completed import finds the same cohort (and reports it all already
 * present). An empty result therefore means the window is wrong or the fetch
 * failed. Set to 0 to permit a deliberate empty-window run.
 */
export const resolveMinCandidateCount = (
  raw: string | undefined = process.env.GAP_IMPORT_MIN_CANDIDATE_COUNT
): number =>
  requireNonNegativeInt(raw, 'GAP_IMPORT_MIN_CANDIDATE_COUNT', MIN_CANDIDATE_COUNT_DEFAULT, {
    note: 'Refuses the run if tubafrenzy returns fewer candidates than this. Use 0 to allow an empty window.',
  });

/**
 * Ceiling on non-marker NULL-`legacy_entry_id` rows across the target shows.
 * Default 0: refuse on the first one. See `countNullKeyRowsForShows`.
 */
export const resolveMaxNullKeyRows = (raw: string | undefined = process.env.GAP_IMPORT_MAX_NULL_KEY_ROWS): number =>
  requireNonNegativeInt(raw, 'GAP_IMPORT_MAX_NULL_KEY_ROWS', MAX_NULL_KEY_ROWS_DEFAULT, {
    note: 'Refuses the run if a target show already holds Backend-originated rows the ON CONFLICT target cannot dedup against.',
  });

export const resolveMaxCohortSize = (raw: string | undefined = process.env.GAP_IMPORT_MAX_COHORT_SIZE): number =>
  requirePositiveInt(raw, 'GAP_IMPORT_MAX_COHORT_SIZE', MAX_COHORT_SIZE_DEFAULT);

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

// ---- Cooperative stop (SIGTERM/SIGINT) ----

let stopRequested = false;
export const requestStop = (): void => {
  stopRequested = true;
};
/** Test-only seam to reset the singleton between tests. */
export const __resetStopForTesting = (): void => {
  stopRequested = false;
};

const stopAwareSleep = async (ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopRequested) return;
    const remaining = deadline - Date.now();
    const tick = Math.min(500, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, tick));
  }
};

// ---- Discovery ----

/**
 * Fetch the date-window candidate net from tubafrenzy and re-apply
 * `resolveEntryTimestamp` + an exact window check to every row — the SQL
 * side (`fetchLegacyEntriesInWindow`) casts deliberately wide (see that
 * function's docstring), so this is the precise filter.
 */
export const discoverCandidates = async (
  window: Window,
  fetchFn: (startMs: number, endMs: number) => Promise<LegacyEntryRow[]> = fetchLegacyEntriesInWindow
): Promise<LegacyEntryRow[]> => {
  const rows = await fetchFn(window.startMs, window.endMs);
  const result: LegacyEntryRow[] = [];
  for (const entry of rows) {
    const addTime = resolveEntryTimestamp(entry.startTime, entry.timeCreated, entry.timeLastModified);
    if (!addTime) continue;
    const t = addTime.getTime();
    if (t < window.startMs || t >= window.endMs) continue;
    result.push(entry);
  }
  return result;
};

/** `COUNT(*)` of `flowsheet.legacy_entry_id IS NOT NULL` — the Backend-side floor's input. */
export const countBackendLegacyEntryIds = async (): Promise<number> => {
  const result = (await db.execute(
    sql`SELECT COUNT(*)::int AS count FROM ${flowsheet} WHERE ${flowsheet.legacy_entry_id} IS NOT NULL`
  )) as unknown as Array<{ count: number }>;
  return Number(result[0]?.count ?? 0);
};

/**
 * Which of `ids` already exist in `flowsheet.legacy_entry_id` — mirrors
 * flowsheet-etl job.ts's runIncremental existingIds check. Raw
 * `db.execute(sql...)` + `intArrayLiteral` rather than the query-builder's
 * bare `.where(inArray(...))` terminal: the query-builder chain in
 * `tests/mocks/database.mock.ts` only resolves on `.returning()`/`.execute()`
 * — a bare `.where()` read would silently return the mock chain object, not
 * rows, in every unit test exercising this function.
 */
export const findExistingLegacyEntryIds = async (ids: number[]): Promise<Set<number>> => {
  if (ids.length === 0) return new Set();
  const idArrayLiteral = intArrayLiteral(ids);
  const result = (await db.execute(sql`
    SELECT legacy_entry_id FROM ${flowsheet} WHERE legacy_entry_id = ANY(${idArrayLiteral}::int[])
  `)) as unknown as Array<{ legacy_entry_id: number }>;
  return new Set(result.map((r) => Number(r.legacy_entry_id)));
};

/**
 * The PII-safe DJ-name chain per Backend `shows.id` — never `auth_user.name`
 * or tubafrenzy's `DJ_NAME` (BS#1393 / BS#1371). Pre-insert read-only SELECT;
 * NOT the post-insert `resolveDjNames` UPDATE in jobs/flowsheet-etl/job.ts
 * (see module docstring).
 *
 * The DECISION is `resolveShowDjName` from `@wxyc/database` — this function
 * only fetches its four inputs. It originally inlined
 * `COALESCE(auth_user.dj_name, shows.legacy_dj_name)`, copied from
 * `flowsheet-etl`'s `resolveDjNames`; BS#2119's review caught that the copy
 * predates `dj_name_override` (BS#1321) and omits the literal-"Anonymous"
 * filter (BS#1286). An imported row would then disagree with every sibling
 * row in the same show, which is the inconsistency BS#1321 exists to prevent,
 * and could put a bare "Anonymous" on the public wire. Matching the donor was
 * matching a stale convention — the donor is what needs updating, not this.
 *
 * Raw SQL for the same `db.execute` testability reason as
 * `findExistingLegacyEntryIds` above, and because it is a cross-schema join
 * (`shows` is `wxyc_schema`-qualified, `auth_user` is default/public).
 */
export const resolveDjNamesForShows = async (showIds: number[]): Promise<Map<number, string | null>> => {
  const map = new Map<number, string | null>();
  if (showIds.length === 0) return map;
  const idArrayLiteral = intArrayLiteral(showIds);
  const result = (await db.execute(sql`
    SELECT
      s.id AS show_id,
      s.dj_name_override AS dj_name_override,
      s.primary_dj_id AS primary_dj_id,
      u.dj_name AS auth_dj_name,
      s.legacy_dj_name AS legacy_dj_name
    FROM ${shows} s
    LEFT JOIN ${user} u ON u.id = s.primary_dj_id
    WHERE s.id = ANY(${idArrayLiteral}::int[])
  `)) as unknown as Array<{
    show_id: number;
    dj_name_override: string | null;
    primary_dj_id: string | null;
    auth_dj_name: string | null;
    legacy_dj_name: string | null;
  }>;
  for (const row of result) {
    const primaryDjId = row.primary_dj_id ?? null;
    map.set(
      Number(row.show_id),
      resolveShowDjName({
        dj_name_override: row.dj_name_override ?? null,
        legacy_dj_name: row.legacy_dj_name ?? null,
        primary_dj_id: primaryDjId,
        // The LEFT JOIN yields a NULL `auth_dj_name` both when there is no
        // user row and when the row's handle is NULL. `resolveShowDjName`
        // distinguishes those, so reconstruct the distinction from
        // `primary_dj_id`: no linked DJ means no user row at all.
        user: primaryDjId == null ? null : { djName: row.auth_dj_name ?? null },
      })
    );
  }
  return map;
};

/**
 * Per Backend `shows.id`, how many flowsheet rows it already holds that this
 * import's safety model cannot see: `legacy_entry_id IS NULL` and not a
 * lifecycle marker.
 *
 * Why it matters (BS#2119 review finding 1). The cohort diff in `runImport`
 * asks "which upstream ids are absent from `flowsheet.legacy_entry_id`?", and
 * the write is guarded by `ON CONFLICT (legacy_entry_id) DO NOTHING`. Both
 * are keyed on that column, so BOTH are blind to a row whose value is NULL —
 * and a unique index does not constrain NULLs, so the conflict target cannot
 * fire against one either. A dj-site-originated April row that reached
 * tubafrenzy but never got its `legacy_entry_id` back-stamped (the live
 * mirror's one-shot `res.finish` attempt was skipped — precisely the orphan
 * class `jobs/legacy-mirror-reconcile` Sweep 2 exists to heal) therefore
 * reads as "missing from Backend" and gets inserted a SECOND time.
 *
 * The README's mitigation — the 15 April shows hold only lifecycle markers —
 * is a measurement taken once, not an invariant the job re-establishes, and
 * the window is operator-widenable via `GAP_IMPORT_WINDOW_START`/`END`. This
 * probe converts it into a run-time precondition.
 *
 * Lifecycle markers (`show_start`/`show_end`/`dj_join`/`dj_leave`) are
 * excluded deliberately: they are Backend-generated, never mirrored as
 * tubafrenzy entry rows, and so legitimately carry a NULL key on exactly the
 * all-legacy shows this job targets. Counting them would refuse every run.
 */
export const countNullKeyRowsForShows = async (backendShowIds: number[]): Promise<Map<number, number>> => {
  const map = new Map<number, number>();
  if (backendShowIds.length === 0) return map;
  const idArrayLiteral = intArrayLiteral(backendShowIds);
  const result = (await db.execute(sql`
    SELECT show_id, COUNT(*)::int AS null_key_rows
    FROM ${flowsheet}
    WHERE show_id = ANY(${idArrayLiteral}::int[])
      AND legacy_entry_id IS NULL
      AND entry_type NOT IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
    GROUP BY show_id
  `)) as unknown as Array<{ show_id: number; null_key_rows: number }>;
  // Zero-fill every probed show: a show absent from the GROUP BY holds no
  // orphans, which must be distinguishable from "not probed" (null) in the
  // per-show breakdown.
  for (const id of backendShowIds) map.set(id, 0);
  for (const row of result) map.set(Number(row.show_id), Number(row.null_key_rows));
  return map;
};

/**
 * `library.id` per `library.legacy_release_id` — the same join
 * `flowsheet-etl/job.ts`'s `resolveAlbumIds` uses, applied inline at insert
 * time as an optimization (the recurring legacy-linkage-resolve cron, every
 * 30 minutes, covers whatever this misses). Raw SQL for the same reason as
 * the two siblings above.
 */
export const resolveAlbumIdsForReleases = async (legacyReleaseIds: number[]): Promise<Map<number, number>> => {
  const map = new Map<number, number>();
  if (legacyReleaseIds.length === 0) return map;
  const idArrayLiteral = intArrayLiteral(legacyReleaseIds);
  const result = (await db.execute(sql`
    SELECT id, legacy_release_id FROM ${library} WHERE legacy_release_id = ANY(${idArrayLiteral}::int[])
  `)) as unknown as Array<{ id: number; legacy_release_id: number | null }>;
  for (const row of result) {
    if (row.legacy_release_id != null) map.set(Number(row.legacy_release_id), Number(row.id));
  }
  return map;
};

// ---- Write path ----

export type InsertBatchFn = (rows: GapImportRow[]) => Promise<number[]>;

/** `ON CONFLICT (legacy_entry_id) DO NOTHING ... RETURNING legacy_entry_id` — never `DO UPDATE`. */
export const insertBatch: InsertBatchFn = async (rows) => {
  if (rows.length === 0) return [];
  const result = await db
    .insert(flowsheet)
    .values(rows)
    .onConflictDoNothing({ target: flowsheet.legacy_entry_id })
    .returning({ legacyEntryId: flowsheet.legacy_entry_id });
  return result.map((r) => r.legacyEntryId).filter((v): v is number => v != null);
};

/** ANALYZE flowsheet after any batch that wrote — bulk-update-playbook rule, mirrors flowsheet-ghost-row-sweep's analyzeTable. */
export const analyzeFlowsheet = async (): Promise<void> => {
  await db.execute(sql`ANALYZE ${flowsheet}`);
};

/**
 * Terminal `metadata_status` distribution for a set of legacy_entry_ids.
 * Called once immediately after `--execute` inserts (an early snapshot —
 * the CDC enrichment worker races this job's own batch gaps, so it is
 * informative, not vacuous, but NOT a final answer) and documented as a
 * standalone re-runnable query in the job README for a later re-check. See
 * the module docstring's "Enrichment residue guard" note: these rows'
 * `add_time` is April-dated, so `flowsheet-metadata-backfill`'s C6 sweep
 * (`BACKFILL_RECOVERY_WINDOW_HOURS`, default 6h) NEVER revisits a straggler
 * — the only automatic claimant is the live CDC worker, at insert time.
 */
export const metadataStatusDistribution = async (ids: number[]): Promise<Record<string, number>> => {
  if (ids.length === 0) return {};
  const idArrayLiteral = intArrayLiteral(ids);
  const result = (await db.execute(sql`
    SELECT metadata_status, COUNT(*)::int AS count
    FROM ${flowsheet}
    WHERE legacy_entry_id = ANY(${idArrayLiteral}::int[])
    GROUP BY metadata_status
  `)) as unknown as Array<{ metadata_status: string; count: number }>;
  const dist: Record<string, number> = {};
  for (const row of result) dist[row.metadata_status] = Number(row.count);
  return dist;
};

/** A copy-pasteable psql query an operator can re-run later to check for enrichment stragglers. */
export const verificationQueryText = (ids: number[]): string =>
  `SELECT metadata_status, COUNT(*) FROM wxyc_schema.flowsheet ` +
  `WHERE legacy_entry_id = ANY(ARRAY[${ids.join(',')}]) GROUP BY metadata_status;`;

// ---- Reporting ----

export type ShowBreakdownRow = {
  legacyShowId: number;
  backendShowId: number | null;
  missing: number;
  /**
   * Non-marker rows the show already holds with a NULL `legacy_entry_id` —
   * see `countNullKeyRowsForShows`. `null` means not probed: either the
   * breakdown was built before the probe (the cohort-ceiling refusal path) or
   * the show has no Backend mapping and so is never written to.
   */
  nullKeyRows: number | null;
};

export const buildShowBreakdown = (
  missing: LegacyEntryRow[],
  showIdMap: Map<number, number>,
  nullKeyByBackendShowId?: Map<number, number>
): ShowBreakdownRow[] => {
  const counts = new Map<number, number>();
  for (const entry of missing) {
    counts.set(entry.showId, (counts.get(entry.showId) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([legacyShowId, missingCount]) => {
      const backendShowId = showIdMap.get(legacyShowId) ?? null;
      return {
        legacyShowId,
        backendShowId,
        missing: missingCount,
        nullKeyRows: backendShowId == null ? null : (nullKeyByBackendShowId?.get(backendShowId) ?? null),
      };
    })
    .sort((a, b) => a.legacyShowId - b.legacyShowId);
};

// ---- Main orchestration ----

export type RunResult = {
  dryRun: boolean;
  window: Window;
  candidateCount: number;
  missingCount: number;
  excludedUnmappedShowCount: number;
  insertedCount: number;
  insertedIds: number[];
  perShowBreakdown: ShowBreakdownRow[];
  metadataStatusSnapshot: Record<string, number>;
  refused: boolean;
  refusalReason: string | null;
  stopped: boolean;
  failed: boolean;
};

/**
 * Whether a wrapping script's `$?` should read this run as unsuccessful.
 *
 * `stopped` counts: a SIGTERM'd run inserted some of its cohort and left the
 * rest, and an operator's `&& echo done` must not fire on that. It lives here
 * rather than inline in job.ts because job.ts calls `void main()` at module
 * scope, so importing it to test would run the job — the same constraint that
 * forced the flowsheet-etl mapper extraction.
 */
export const shouldExitNonZero = (result: RunResult): boolean => result.failed || result.refused || result.stopped;

export type RunImportOptions = {
  dryRun: boolean;
  window?: Window;
  batchSize?: number;
  batchGapMs?: number;
  minBackendIdCount?: number;
  minCandidateCount?: number;
  maxCohortSize?: number;
  maxNullKeyRows?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  // Injectable seams — tests only; default to the real implementations above.
  discoverCandidatesFn?: (window: Window) => Promise<LegacyEntryRow[]>;
  countBackendLegacyEntryIdsFn?: () => Promise<number>;
  findExistingLegacyEntryIdsFn?: (ids: number[]) => Promise<Set<number>>;
  buildShowIdMapFn?: () => Promise<Map<number, number>>;
  countNullKeyRowsForShowsFn?: (backendShowIds: number[]) => Promise<Map<number, number>>;
  resolveDjNamesForShowsFn?: (showIds: number[]) => Promise<Map<number, string | null>>;
  resolveAlbumIdsForReleasesFn?: (legacyReleaseIds: number[]) => Promise<Map<number, number>>;
  insertBatchFn?: InsertBatchFn;
  analyzeFlowsheetFn?: () => Promise<void>;
  metadataStatusDistributionFn?: (ids: number[]) => Promise<Record<string, number>>;
};

const emptyRunResult = (dryRun: boolean, window: Window): RunResult => ({
  dryRun,
  window,
  candidateCount: 0,
  missingCount: 0,
  excludedUnmappedShowCount: 0,
  insertedCount: 0,
  insertedIds: [],
  perShowBreakdown: [],
  metadataStatusSnapshot: {},
  refused: false,
  refusalReason: null,
  stopped: false,
  failed: false,
});

export const runImport = async (opts: RunImportOptions): Promise<RunResult> => {
  const dryRun = opts.dryRun;
  const window = opts.window ?? resolveWindow();
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const batchGapMs = opts.batchGapMs ?? resolveBatchGapMs();
  const minBackendIdCount = opts.minBackendIdCount ?? resolveMinBackendIdCount();
  const minCandidateCount = opts.minCandidateCount ?? resolveMinCandidateCount();
  const maxCohortSize = opts.maxCohortSize ?? resolveMaxCohortSize();
  const maxNullKeyRows = opts.maxNullKeyRows ?? resolveMaxNullKeyRows();
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  const discoverCandidatesFn = opts.discoverCandidatesFn ?? discoverCandidates;
  const countBackendLegacyEntryIdsFn = opts.countBackendLegacyEntryIdsFn ?? countBackendLegacyEntryIds;
  const findExistingLegacyEntryIdsFn = opts.findExistingLegacyEntryIdsFn ?? findExistingLegacyEntryIds;
  const buildShowIdMapFn = opts.buildShowIdMapFn ?? (() => defaultBuildShowIdMap(db));
  const countNullKeyRowsForShowsFn = opts.countNullKeyRowsForShowsFn ?? countNullKeyRowsForShows;
  const resolveDjNamesForShowsFn = opts.resolveDjNamesForShowsFn ?? resolveDjNamesForShows;
  const resolveAlbumIdsForReleasesFn = opts.resolveAlbumIdsForReleasesFn ?? resolveAlbumIdsForReleases;
  const insertBatchFn = opts.insertBatchFn ?? insertBatch;
  const analyzeFlowsheetFn = opts.analyzeFlowsheetFn ?? analyzeFlowsheet;
  const metadataStatusDistributionFn = opts.metadataStatusDistributionFn ?? metadataStatusDistribution;

  const result = emptyRunResult(dryRun, window);

  // BS#2147: the loop itself (probe + fail-open + stop-awareness + elapsed-
  // time cap) now lives in the shared `buildWaitForQuietPeriod`. `onPause`
  // and `onProbeError` reproduce this job's exact prior log lines/fields so
  // ops greps against `live_activity_pause`/`probe_error` don't drift.
  const waitForQuietPeriod = buildWaitForQuietPeriod({
    lookbackSeconds: liveActivityLookbackSeconds,
    pauseMs: liveActivityPauseMs,
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
  });

  log('info', 'started', `${JOB_NAME} starting`, {
    dry_run: dryRun,
    window_start_ms: window.startMs,
    window_end_ms: window.endMs,
    batch_size: batchSize,
    batch_gap_ms: batchGapMs,
    min_backend_id_count: minBackendIdCount,
    max_cohort_size: maxCohortSize,
    min_candidate_count: minCandidateCount,
    max_null_key_rows: maxNullKeyRows,
  });

  let failure: unknown = null;

  try {
    // Single labeled block so every terminal path (no-op, refusal, dry-run
    // report, or a completed/stopped write) falls through to the ONE
    // Sentry-summary + final-log footer below, rather than returning early
    // from scattered points and skipping it — mirrors flowsheet-ghost-row-sweep's
    // single-exit-through-summary shape (there, via a `failure` variable and
    // no early returns at all; here, `break mainFlow` serves the same role
    // for the additional non-error terminal states this job has: refused
    // and clean-no-op).
    mainFlow: {
      // 1. Discover the date-window candidate set from tubafrenzy.
      const candidates = await discoverCandidatesFn(window);
      result.candidateCount = candidates.length;
      log('info', 'discovered', `${candidates.length} candidate row(s) in window`, {
        candidate_count: candidates.length,
      });

      if (candidates.length < minCandidateCount) {
        result.refused = true;
        result.refusalReason =
          `Discovery returned ${candidates.length} candidate row(s), below GAP_IMPORT_MIN_CANDIDATE_COUNT ` +
          `(${minCandidateCount}). Candidates come from tubafrenzy and do not depend on Backend state, so ` +
          `even a re-run of a completed import finds the same cohort — an empty window almost always means ` +
          `the window bounds are wrong or the tubafrenzy read failed. Set GAP_IMPORT_MIN_CANDIDATE_COUNT=0 ` +
          `to allow a deliberate empty-window run.`;
        log('error', 'refused_candidate_floor', result.refusalReason, {
          candidate_count: candidates.length,
          window_start_ms: window.startMs,
          window_end_ms: window.endMs,
        });
        captureError(new Error(result.refusalReason), 'refused_candidate_floor', {
          candidate_count: candidates.length,
        });
        break mainFlow;
      }

      if (candidates.length === 0) {
        break mainFlow;
      }

      // 2. Backend-side floor: an undersized read means the read failed, not
      // that Backend is empty (see module docstring).
      const backendIdCount = await countBackendLegacyEntryIdsFn();
      if (backendIdCount < minBackendIdCount) {
        result.refused = true;
        result.refusalReason =
          `Backend-side legacy_entry_id count (${backendIdCount}) is below the floor ` +
          `(${minBackendIdCount}). This almost always means the read failed, not that Backend ` +
          `is genuinely empty. Set GAP_IMPORT_MIN_BACKEND_ID_COUNT=0 to override for a deliberate ` +
          `tiny/empty test run.`;
        log('error', 'refused_backend_floor', result.refusalReason, { backend_id_count: backendIdCount });
        captureError(new Error(result.refusalReason), 'refused_backend_floor', { backend_id_count: backendIdCount });
        break mainFlow;
      }

      // 3. Existence check + cohort ceiling.
      const candidateIds = candidates.map((c) => c.id);
      const existingIds = await findExistingLegacyEntryIdsFn(candidateIds);
      const missing = candidates.filter((c) => !existingIds.has(c.id));
      result.missingCount = missing.length;
      log('info', 'diffed', `${missing.length}/${candidates.length} candidate row(s) missing from Backend`, {
        candidate_count: candidates.length,
        missing_count: missing.length,
        already_present_count: candidates.length - missing.length,
      });

      if (missing.length > maxCohortSize) {
        // Diagnostics before refusing: a raw per-legacy-show-id breakdown
        // (no Backend-id lookup needed) so the operator can see WHY the
        // cohort is oversized without another round trip.
        result.perShowBreakdown = buildShowBreakdown(missing, new Map());
        result.refused = true;
        result.refusalReason =
          `Missing-row cohort (${missing.length}) exceeds GAP_IMPORT_MAX_COHORT_SIZE (${maxCohortSize}). ` +
          `A cohort this much larger than expected is a comparison bug, not a discovery — refusing rather ` +
          `than attempt a mass insert.`;
        log('error', 'refused_cohort_ceiling', result.refusalReason, {
          missing_count: missing.length,
          per_show_breakdown: result.perShowBreakdown,
        });
        captureError(new Error(result.refusalReason), 'refused_cohort_ceiling', { missing_count: missing.length });
        break mainFlow;
      }

      if (missing.length === 0) {
        break mainFlow;
      }

      // 4. Resolve show_id (legacy_show_id -> Backend id); exclude anything
      // unmapped rather than insert with a null show_id — every show in this
      // cohort is expected to already exist in Backend (see the issue).
      const showIdMap = await buildShowIdMapFn();
      // Provisional — re-built with the null-key counts at step 4b, once the
      // set of shows actually being written to is known.
      result.perShowBreakdown = buildShowBreakdown(missing, showIdMap);

      const resolvable: Array<{ entry: LegacyEntryRow; showId: number }> = [];
      let excludedUnmappedShowCount = 0;
      for (const entry of missing) {
        const showId = showIdMap.get(entry.showId);
        if (showId == null) {
          excludedUnmappedShowCount += 1;
          continue;
        }
        resolvable.push({ entry, showId });
      }
      result.excludedUnmappedShowCount = excludedUnmappedShowCount;
      if (excludedUnmappedShowCount > 0) {
        log(
          'warn',
          'unmapped_shows_excluded',
          `${excludedUnmappedShowCount} row(s) excluded: legacy_show_id not found in Backend`,
          { excluded_count: excludedUnmappedShowCount }
        );
      }

      const distinctShowIds = Array.from(new Set(resolvable.map((r) => r.showId)));

      // 4b. NULL-key orphan guard. `ON CONFLICT (legacy_entry_id) DO NOTHING`
      // cannot dedup against a NULL key, and the cohort diff above is keyed
      // on the same column, so a Backend-originated row that never got its
      // back-stamp is invisible to both and would be inserted a second time.
      // Probe only the shows about to be written to, and refuse before any
      // write — including in dry-run, so the report can't advertise a safe
      // import that isn't one. See countNullKeyRowsForShows.
      const nullKeyByShow = await countNullKeyRowsForShowsFn(distinctShowIds);
      result.perShowBreakdown = buildShowBreakdown(missing, showIdMap, nullKeyByShow);
      const totalNullKeyRows = Array.from(nullKeyByShow.values()).reduce((sum, n) => sum + n, 0);
      if (totalNullKeyRows > maxNullKeyRows) {
        const offenders = Array.from(nullKeyByShow.entries())
          .filter(([, n]) => n > 0)
          .map(([showId, n]) => `${showId}:${n}`)
          .join(', ');
        result.refused = true;
        result.refusalReason =
          `${totalNullKeyRows} non-marker row(s) with a NULL legacy_entry_id already exist in the target ` +
          `show(s) [backend_show_id:count — ${offenders}], above GAP_IMPORT_MAX_NULL_KEY_ROWS ` +
          `(${maxNullKeyRows}). Those rows are invisible to this job's existence check AND to its ` +
          `ON CONFLICT (legacy_entry_id) target, so importing could duplicate a row a DJ already entered. ` +
          `Reconcile them first (jobs/legacy-mirror-reconcile heals the missing back-stamp), or raise the ` +
          `ceiling once you have confirmed by hand that no candidate id corresponds to one of them.`;
        log('error', 'refused_null_key_rows', result.refusalReason, {
          total_null_key_rows: totalNullKeyRows,
          per_show_breakdown: result.perShowBreakdown,
        });
        captureError(new Error(result.refusalReason), 'refused_null_key_rows', {
          total_null_key_rows: totalNullKeyRows,
        });
        break mainFlow;
      }

      // 5. Pre-resolve dj_name (read-only SELECT, never the post-insert
      // resolveDjNames UPDATE) and album_id (opportunistic, optimization only).
      const djNameMap = await resolveDjNamesForShowsFn(distinctShowIds);
      const distinctReleaseIds = Array.from(
        new Set(resolvable.map((r) => r.entry.legacyReleaseId).filter((v): v is number => v != null))
      );
      const albumIdMap = await resolveAlbumIdsForReleasesFn(distinctReleaseIds);

      // 6. Build insert rows.
      const rows: GapImportRow[] = [];
      for (const { entry, showId } of resolvable) {
        const row = buildInsertRow(entry, {
          showId,
          djName: djNameMap.get(showId) ?? null,
          albumId: entry.legacyReleaseId != null ? (albumIdMap.get(entry.legacyReleaseId) ?? null) : null,
        });
        if (row) rows.push(row);
      }

      if (dryRun) {
        log('info', 'dry_run_report', `dry-run: ${rows.length} row(s) would be inserted`, {
          would_insert_count: rows.length,
          legacy_entry_ids: rows.map((r) => r.legacy_entry_id),
          per_show_breakdown: result.perShowBreakdown,
        });
        break mainFlow;
      }

      // 7. Batched insert with cooperative pause + inter-batch gap.
      const insertedIds: number[] = [];
      for (let i = 0; i < rows.length; i += batchSize) {
        if (stopRequested || (await waitForQuietPeriod())) {
          result.stopped = true;
          break;
        }
        const batch = rows.slice(i, i + batchSize);
        const batchIds = await insertBatchFn(batch);
        insertedIds.push(...batchIds);
        log('info', 'batch_done', `inserted ${batchIds.length}/${batch.length} row(s) in this batch`, {
          batch_index: Math.floor(i / batchSize) + 1,
          batch_attempted: batch.length,
          batch_inserted: batchIds.length,
          total_inserted: insertedIds.length,
        });

        const isLastBatch = i + batchSize >= rows.length;
        if (!isLastBatch && batchGapMs > 0 && !stopRequested) {
          await stopAwareSleep(batchGapMs);
        }
      }
      result.insertedIds = insertedIds;
      result.insertedCount = insertedIds.length;

      if (insertedIds.length > 0) {
        try {
          await analyzeFlowsheetFn();
          log('info', 'analyzed', 'ANALYZE flowsheet complete');
        } catch (error) {
          log('warn', 'analyze_error', 'ANALYZE flowsheet failed', { error_message: errorMessage(error) });
          captureError(error, 'analyze_error');
          // Not a correctness failure — the rows are inserted. Surface loudly, don't fail the run over stats.
        }

        try {
          result.metadataStatusSnapshot = await metadataStatusDistributionFn(insertedIds);
          log(
            'info',
            'metadata_status_snapshot',
            'immediate post-insert metadata_status distribution (a snapshot, not terminal — see README)',
            { snapshot: result.metadataStatusSnapshot, reverify_query: verificationQueryText(insertedIds) }
          );
        } catch (error) {
          log('warn', 'metadata_status_snapshot_error', 'failed to read the post-insert metadata_status snapshot', {
            error_message: errorMessage(error),
          });
          captureError(error, 'metadata_status_snapshot_error');
        }
      }
    }
  } catch (error) {
    failure = error;
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: errorMessage(error) });
    captureError(error, 'failed');
  }

  result.failed = failure !== null;

  Sentry.startSpan(
    {
      name: 'flowsheet_april_gap_import.run.summary',
      attributes: {
        'gap_import.dry_run': result.dryRun,
        'gap_import.candidate_count': result.candidateCount,
        'gap_import.missing_count': result.missingCount,
        'gap_import.excluded_unmapped_show_count': result.excludedUnmappedShowCount,
        'gap_import.inserted_count': result.insertedCount,
        'gap_import.refused': result.refused,
        'gap_import.stopped': result.stopped,
        'gap_import.failed': result.failed,
      },
    },
    () => {
      /* attributes set at creation */
    }
  );

  const step = result.failed ? 'failed' : result.refused ? 'refused' : result.stopped ? 'stopped' : 'finished';
  const level = result.failed || result.refused ? 'error' : 'info';
  log(level, step, `${JOB_NAME} ${step}`, {
    dry_run: dryRun,
    candidate_count: result.candidateCount,
    missing_count: result.missingCount,
    inserted_count: result.insertedCount,
    refused: result.refused,
    stopped: result.stopped,
    failed: result.failed,
  });

  return result;
};
