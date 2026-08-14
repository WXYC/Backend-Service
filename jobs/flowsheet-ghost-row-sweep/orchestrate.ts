/**
 * The flowsheet + rotation ghost-row sweep (BS#1887, mechanism slice of the
 * BS#1083 cleanup).
 *
 * `flowsheet-etl` and `rotation-etl` are upsert-only: each tick reconciles
 * tubafrenzy rows it currently sees into Backend-Service via `ON CONFLICT
 * (legacy_entry_id) DO UPDATE` / `ON CONFLICT (legacy_rotation_id) DO
 * UPDATE`. Neither ETL deletes a BS row when tubafrenzy deletes (or never
 * had) the corresponding upstream row — there's no anti-join in either
 * writer — and tubafrenzy's own delete webhook is fire-and-forget, so a
 * failed delivery leaves a permanent ghost. This job is the reconciliation
 * pass neither ETL performs: it anti-joins Backend's `legacy_entry_id` /
 * `legacy_rotation_id` against an authoritative upstream keyspace (see
 * `keyspace-source.ts`) and DELETEs whatever's left over.
 *
 * Shape vs. `streaming-url-remediation` (the structural donor): that job's
 * candidate net is a SQL predicate the database can evaluate directly
 * (`NOT ILIKE`), so its batch SELECT doubles as the candidate filter. This
 * job's candidate net is "not a member of a Set loaded from an external
 * source" — not expressible as a `NOT IN (<huge list>)` without either
 * shipping a giant literal or a slow per-row round trip. Per the issue's
 * implementation note, the membership test happens IN-PROCESS: the batch
 * SELECT pages every row with a non-null legacy id (id-cursor, ORDER BY id),
 * and each row's legacy id is tested against the loaded `Set<number>`
 * in-memory. That also means this job has no cheap SQL-side "candidates"
 * COUNT the way the donor does — the ghost count is a running total
 * produced by the scan itself, reported once the full pass (or a stop)
 * completes.
 *
 * Dry-run (the default) performs the same paged scan and in-process test
 * with zero writes — every row that would be deleted under `--execute` is
 * counted and a bounded sample of orphan ids is logged.
 *
 * DELETEs are batched (one `id = ANY(...)` statement per page) with an
 * `ANALYZE` after each table's write pass, per the bulk-update playbook.
 * Resumability is id-cursor per target (`GHOST_SWEEP_FLOWSHEET_AFTER_ID` /
 * `GHOST_SWEEP_ROTATION_AFTER_ID`); the cursor advances only after a page's
 * DELETE call returns successfully (or in dry-run, which writes nothing to
 * strand), so a failure the client SEES (a thrown error) never strands
 * unswept ghosts behind the logged cursor — re-running from the same cursor
 * re-selects and re-tests them. A failure the client DOESN'T see (a page
 * that appeared to commit but didn't survive a crash under async commit)
 * is a distinct hazard the post-run verification pass below exists to catch.
 *
 * Blast radius (verified against schema, see the issue body): deleting a
 * `flowsheet` row cascades to `flowsheet_linkage_review` (migration 0067,
 * `ON DELETE CASCADE`); deleting a `rotation` row SETs NULL any referencing
 * `flowsheet.rotation_id` (migration 0097, `ON DELETE SET NULL`). Both are
 * the intended semantics and require no explicit child cleanup — the FK
 * handles it.
 *
 * Three safety nets a plain anti-join-and-DELETE doesn't get for free:
 *
 *   - **Empty keyspace floor** (`GHOST_SWEEP_MIN_KEYSPACE_SIZE`, default 1).
 *     A `LegacyKeyspaceSource` that returns an empty (or suspiciously tiny)
 *     `Set` — a missing file, a truncated extraction, a misconfigured path —
 *     would anti-join *every* row as a ghost. Nothing about that failure
 *     mode is distinguishable in-process from "tubafrenzy genuinely has zero
 *     surviving rows," so the run refuses outright rather than risk
 *     `--execute` emptying a live table. `--execute` from job.ts's CLI is
 *     already required for it to even read from a `LegacyKeyspaceSource` that
 *     has never proven itself against production; this floor is what makes an
 *     operator's fat-fingered *empty*-file path fail loud.
 *   - **Ghost-fraction ceiling** (`GHOST_SWEEP_MAX_GHOST_RATIO`, default
 *     0.5). The floor above only catches a *fully empty* keyspace; a keyspace
 *     truncated to a small-but-nonzero fraction of its real size sails past
 *     it and would flag the majority of a live table as ghosts. Once a full
 *     page has been scanned, a running ghost fraction above the ceiling
 *     aborts the target (before that page's DELETE, so a truncated keyspace
 *     trips with zero rows removed) — a healthy sweep clears a small residual
 *     of failed-webhook orphans, never most of the table. Evaluated in
 *     dry-run too, so it surfaces during the operator's dry-run review.
 *   - **Post-run ghost-free verification.** Async commit
 *     (`DB_SYNCHRONOUS_COMMIT=off`, set by the Dockerfile per the
 *     bulk-update playbook) means a page's DELETE can
 *     appear to succeed to the Node client and then be lost to a Postgres
 *     crash inside the fsync window — the id-cursor would already have
 *     advanced past it, so a resumed follow-up run using the logged cursor
 *     would never re-select that row. After a target's main sweep finishes
 *     cleanly (not stopped, not failed) *and actually deleted something*, the
 *     same afterId..end range — exactly what this run swept — is re-scanned
 *     read-only; any ghost still present fails the run loudly (`remaining` in
 *     the summary) instead of silently leaving a permanent leftover behind an
 *     already-advanced cursor. Scope note: verification covers this run's
 *     `[afterId, end]` range, not the whole table — the async-commit hazard
 *     it guards is a Postgres *crash*, which breaks the client's connection
 *     and ends the run as a `failed` (not a clean `stopped`), so a range
 *     swept by an earlier clean stop never carried an undetected lost DELETE.
 *     A single run from `afterId=0` therefore verifies the whole table; after
 *     a *failed* run, resume from a conservative cursor rather than the last
 *     logged one.
 *
 * Cooperative pause, SIGTERM stop, and loadBatch retry mirror
 * `jobs/streaming-url-remediation/orchestrate.ts`.
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  checkLiveActivity as defaultCheckLiveActivity,
  intArrayLiteral,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  buildWaitForQuietPeriod,
  requireNonNegativeInt,
  requirePositiveInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import type { LegacyKeyspaceSource } from './keyspace-source.js';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'flowsheet-ghost-row-sweep';

/** Page size for both the candidate scan and the batched DELETE. Mirrors the bulk-update playbook default. */
export const BATCH_SIZE = 5000;

/** How many orphan ids the dry-run (and execute) summary carries per target. */
export const SAMPLE_SIZE_DEFAULT = 20;

export const DELETE_TIMEOUT_MS_DEFAULT = 300_000;
export const ANALYZE_TIMEOUT_MS_DEFAULT = 300_000;

/**
 * Floor below which a loaded keyspace is refused rather than trusted. An
 * empty or near-empty `Set` almost always means the keyspace source is
 * missing/truncated/misconfigured, not that tubafrenzy genuinely has that
 * few surviving rows — and trusting it would anti-join nearly every row as
 * a ghost. 1 (not 0) is the default so a keyspace source that returns an
 * empty Set on a read error it swallowed is still caught.
 *
 * The floor only catches an *empty* Set, though — a keyspace that lost most
 * (but not all) of its ids to a partial extraction sails past it and would
 * anti-join the majority of a live table as ghosts. `MAX_GHOST_RATIO`
 * (below) is the companion guard for that failure mode.
 */
export const MIN_KEYSPACE_SIZE_DEFAULT = 1;

/**
 * Ceiling on the running ghost fraction (`ghosts / scanned`) a sweep will
 * tolerate before refusing to continue. The absolute keyspace floor only
 * catches a *fully empty* Set; a keyspace truncated to a small-but-nonzero
 * fraction of its real size passes the floor and would flag the majority of
 * a live table as ghosts. A healthy sweep clears a small residual of failed
 * delete-webhook orphans, never most of the table — so once a full page has
 * been scanned, a ghost fraction above this ceiling almost always means the
 * keyspace source is truncated or pointed at the wrong data, and the run
 * refuses rather than mass-delete. The guard arms only after the first full
 * page (see `runTarget`) so a genuinely tiny fixture table can't trip it,
 * and applies in dry-run too so an operator sees it during the mandatory
 * dry-run review, before ever passing `--execute`. Set to 1 to disable (a
 * deliberate large-sweep run only).
 */
export const MAX_GHOST_RATIO_DEFAULT = 0.5;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const ROTATION_TABLE = sql.raw(`"${SCHEMA}"."rotation"`);

const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000];

export type SweepTarget = 'flowsheet' | 'rotation';

interface TargetMeta {
  table: ReturnType<typeof sql.raw>;
  /** Serial PK — doubles as the id-cursor column. */
  pkColumn: 'id';
  /** The tubafrenzy-assigned surrogate key column this target reconciles against the keyspace source. */
  legacyColumn: 'legacy_entry_id' | 'legacy_rotation_id';
}

const TARGET_META: Record<SweepTarget, TargetMeta> = {
  flowsheet: { table: FLOWSHEET_TABLE, pkColumn: 'id', legacyColumn: 'legacy_entry_id' },
  rotation: { table: ROTATION_TABLE, pkColumn: 'id', legacyColumn: 'legacy_rotation_id' },
};

interface CandidateRow {
  id: number;
  legacy_id: number;
}

const loadBatchOnce = async (target: SweepTarget, afterId: number, batchSize: number): Promise<CandidateRow[]> => {
  const { table, pkColumn, legacyColumn } = TARGET_META[target];
  const pkRef = sql.raw(`"${pkColumn}"`);
  const legacyRef = sql.raw(`"${legacyColumn}"`);
  const query = sql`
    SELECT ${pkRef} AS "id", ${legacyRef} AS "legacy_id"
    FROM ${table}
    WHERE ${legacyRef} IS NOT NULL
      AND ${pkRef} > ${afterId}
    ORDER BY ${pkRef} ASC
    LIMIT ${batchSize}
  `;
  const rows = (await db.execute(query)) as unknown as CandidateRow[];
  return rows ?? [];
};

/**
 * loadBatch with transient-error retry. Honors stopRequested so shutdown
 * isn't blocked by retry backoffs; exhausting retries throws the most
 * recent error (the caller distinguishes stop from failure via the flag).
 */
const loadBatch = async (target: SweepTarget, afterId: number, batchSize: number): Promise<CandidateRow[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadBatchOnce(target, afterId, batchSize);
    } catch (error) {
      lastError = error;
      if (stopRequested || attempt + 1 >= LOAD_BATCH_MAX_ATTEMPTS) throw error;
      const backoff = LOAD_BATCH_BACKOFF_MS[attempt] ?? LOAD_BATCH_BACKOFF_MS[LOAD_BATCH_BACKOFF_MS.length - 1];
      log('warn', 'load_batch_retry', `loadBatch attempt ${attempt + 1} failed; retrying in ${backoff}ms`, {
        target,
        attempt: attempt + 1,
        after_id: afterId,
        backoff_ms: backoff,
        error_message: errorMessage(error),
      });
      await stopAwareSleep(backoff);
      if (stopRequested) throw error;
    }
  }
  // Unreachable: the loop either returns or throws. Kept for TS narrowing.
  throw lastError;
};

/** The batched-delete seam — injectable so `runSweep` tests don't route writes through the db mock. */
export type DeleteBatchFn = (target: SweepTarget, ids: number[], deleteTimeoutMs: number) => Promise<number>;
/** The post-pass ANALYZE seam — injectable for the same reason. */
export type AnalyzeFn = (target: SweepTarget, analyzeTimeoutMs: number) => Promise<void>;

/**
 * DELETE one page of ghost ids in a single statement inside a raised-timeout
 * transaction. Returns the number of rows actually removed.
 */
export const deleteBatch = async (target: SweepTarget, ids: number[], deleteTimeoutMs: number): Promise<number> => {
  if (ids.length === 0) return 0;
  const { table, pkColumn } = TARGET_META[target];
  const pkRef = sql.raw(`"${pkColumn}"`);
  const idArrayLiteral = intArrayLiteral(ids);
  const deleteSql = sql`
    DELETE FROM ${table}
    WHERE ${pkRef} = ANY(${idArrayLiteral}::int[])
  `;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(deleteTimeoutMs))}`);
    return tx.execute(deleteSql);
  });
  return Number((result as { count?: number }).count ?? ids.length);
};

/**
 * ANALYZE a table in its own raised-timeout transaction after its DELETE
 * pass — the bulk-update playbook rule applies to DELETEs the same as
 * UPDATEs (stale planner stats on the touched table).
 */
export const analyzeTable = async (target: SweepTarget, analyzeTimeoutMs: number): Promise<void> => {
  const { table } = TARGET_META[target];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(analyzeTimeoutMs))}`);
    await tx.execute(sql`ANALYZE ${table}`);
  });
};

export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveBatchSize = (raw: string | undefined = process.env.GHOST_SWEEP_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'GHOST_SWEEP_BATCH_SIZE', BATCH_SIZE);

export const resolveDeleteTimeoutMs = (raw: string | undefined = process.env.GHOST_SWEEP_DELETE_TIMEOUT_MS): number =>
  requirePositiveInt(raw, 'GHOST_SWEEP_DELETE_TIMEOUT_MS', DELETE_TIMEOUT_MS_DEFAULT);

export const resolveAnalyzeTimeoutMs = (raw: string | undefined = process.env.GHOST_SWEEP_ANALYZE_TIMEOUT_MS): number =>
  requirePositiveInt(raw, 'GHOST_SWEEP_ANALYZE_TIMEOUT_MS', ANALYZE_TIMEOUT_MS_DEFAULT);

export const resolveSampleSize = (raw: string | undefined = process.env.GHOST_SWEEP_SAMPLE_SIZE): number =>
  requireNonNegativeInt(raw, 'GHOST_SWEEP_SAMPLE_SIZE', SAMPLE_SIZE_DEFAULT, {
    note: 'Use 0 to omit the orphan-id sample from the summary.',
  });

export const resolveMinKeyspaceSize = (raw: string | undefined = process.env.GHOST_SWEEP_MIN_KEYSPACE_SIZE): number =>
  requireNonNegativeInt(raw, 'GHOST_SWEEP_MIN_KEYSPACE_SIZE', MIN_KEYSPACE_SIZE_DEFAULT, {
    note: 'Refuses the run if either loaded keyspace is smaller than this. Use 0 to disable (a deliberate tiny/empty-fixture run only).',
  });

/**
 * Parse `GHOST_SWEEP_MAX_GHOST_RATIO` — a float in `(0, 1]`, not an integer,
 * so it can't reuse the shared int parsers. Empty/unset → default. `1`
 * disables the guard (the ratio can never exceed 1). `<= 0` is rejected: a
 * ceiling of 0 would abort on the very first ghost, which is never intended.
 */
export const resolveMaxGhostRatio = (raw: string | undefined = process.env.GHOST_SWEEP_MAX_GHOST_RATIO): number => {
  if (raw === undefined || raw.trim() === '') return MAX_GHOST_RATIO_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(
      `Invalid GHOST_SWEEP_MAX_GHOST_RATIO=${JSON.stringify(raw)}: must be a number in (0, 1]. ` +
        'Set 1 to disable the guard (a deliberate large-sweep run only).'
    );
  }
  return n;
};

export const resolveAfterId = (envName: string, raw: string | undefined): number =>
  requireNonNegativeInt(raw, envName, 0, {
    note: 'Resume cursor — the summary log of the previous run carries the per-target last_id.',
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

/** Cooperative cancellation flag for graceful shutdown on SIGTERM. */
let stopRequested = false;
export const requestStop = (): void => {
  stopRequested = true;
};
/** Test-only seam to reset the singleton between tests. */
export const __resetStopForTesting = (): void => {
  stopRequested = false;
};

/** Stop-aware sleep: returns early if stopRequested flips during the wait. */
const stopAwareSleep = async (ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopRequested) return;
    const remaining = deadline - Date.now();
    const tick = Math.min(500, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, tick));
  }
};

export type TargetTotals = {
  scanned: number;
  /** Rows the anti-join flagged as ghosts (not present in the keyspace source). */
  ghosts: number;
  /** Rows actually DELETEd (execute only; 0 in dry-run). */
  removed: number;
  batches: number;
  last_id: number;
  sample: number[];
  /** Ghosts still present after a post-run re-scan (execute + clean-finish only); -1 when not verified. */
  remaining: number;
};

export type RunResult = {
  flowsheet: TargetTotals;
  rotation: TargetTotals;
  dryRun: boolean;
  stopped: boolean;
  /** True iff a keyspace-load error, write failure, or retry exhaustion ended the run. */
  failed: boolean;
};

const emptyTargetTotals = (): TargetTotals => ({
  scanned: 0,
  ghosts: 0,
  removed: 0,
  batches: 0,
  last_id: 0,
  sample: [],
  remaining: -1,
});

/**
 * Read-only re-scan of `[afterId, end]` for `target`, counting rows whose
 * legacy id is still absent from `keyspace` — the same net the main sweep
 * just applied, minus the delete. Used only for post-run verification, so a
 * non-zero result means the corresponding page's DELETE didn't durably
 * land (see the module doc's async-commit note) even though the main loop
 * believed it had.
 *
 * Returns `null` (not a count) if a SIGTERM interrupts the re-scan before
 * it reaches the end of the range — a partial count would understate
 * `remaining` and could read as "verified clean" when it's really
 * "stopped early." The caller treats `null` as unverified, not zero.
 */
const countRemainingGhosts = async (
  target: SweepTarget,
  afterId: number,
  keyspace: Set<number>,
  batchSize: number
): Promise<number | null> => {
  let lastId = afterId;
  let remaining = 0;
  while (true) {
    if (stopRequested) return null;
    const rows = await loadBatch(target, lastId, batchSize);
    if (rows.length === 0) return remaining;
    for (const row of rows) {
      if (!keyspace.has(row.legacy_id)) remaining += 1;
    }
    lastId = rows[rows.length - 1].id;
  }
};

export const runSweep = async (opts: {
  dryRun: boolean;
  keyspaceSource: LegacyKeyspaceSource;
  batchSize?: number;
  deleteTimeoutMs?: number;
  analyzeTimeoutMs?: number;
  sampleSize?: number;
  /** Refuses the run if either loaded keyspace is smaller than this. 0 disables (tests / deliberate tiny fixtures only). */
  minKeyspaceSize?: number;
  /** Aborts a target once its running ghost fraction exceeds this (after the first full page). 1 disables. */
  maxGhostRatio?: number;
  flowsheetAfterId?: number;
  rotationAfterId?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  /** Injected write path (tests only); defaults to the module `deleteBatch`. */
  deleteBatch?: DeleteBatchFn;
  /** Injected ANALYZE path (tests only); defaults to the module `analyzeTable`. */
  analyzeTable?: AnalyzeFn;
}): Promise<RunResult> => {
  const dryRun = opts.dryRun;
  const deleteBatchFn = opts.deleteBatch ?? deleteBatch;
  const analyzeFn = opts.analyzeTable ?? analyzeTable;
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const deleteTimeoutMs = opts.deleteTimeoutMs ?? resolveDeleteTimeoutMs();
  const analyzeTimeoutMs = opts.analyzeTimeoutMs ?? resolveAnalyzeTimeoutMs();
  const sampleSize = opts.sampleSize ?? resolveSampleSize();
  const minKeyspaceSize = opts.minKeyspaceSize ?? resolveMinKeyspaceSize();
  const maxGhostRatio = opts.maxGhostRatio ?? resolveMaxGhostRatio();
  const flowsheetAfterId =
    opts.flowsheetAfterId ??
    resolveAfterId('GHOST_SWEEP_FLOWSHEET_AFTER_ID', process.env.GHOST_SWEEP_FLOWSHEET_AFTER_ID);
  const rotationAfterId =
    opts.rotationAfterId ?? resolveAfterId('GHOST_SWEEP_ROTATION_AFTER_ID', process.env.GHOST_SWEEP_ROTATION_AFTER_ID);
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

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
    batch_size: batchSize,
    delete_timeout_ms: deleteTimeoutMs,
    analyze_timeout_ms: analyzeTimeoutMs,
    sample_size: sampleSize,
    max_ghost_ratio: maxGhostRatio,
    flowsheet_after_id: flowsheetAfterId,
    rotation_after_id: rotationAfterId,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
  });

  const result: RunResult = {
    flowsheet: emptyTargetTotals(),
    rotation: emptyTargetTotals(),
    dryRun,
    stopped: false,
    failed: false,
  };
  // Pre-seed resume cursors so a run stopped before a target starts still
  // logs the operator's own cursor back out (not a misleading 0).
  result.flowsheet.last_id = flowsheetAfterId;
  result.rotation.last_id = rotationAfterId;
  let failure: { error: unknown } | null = null;

  // Loaded once, up front — a keyspace-load failure is a run-ending failure,
  // not a per-target one, since neither target's anti-join can proceed
  // without it.
  let keyspaces: { flowsheet: Set<number>; rotation: Set<number> } | null = null;
  let loadedKeyspaceSizes: { flowsheet: number; rotation: number } | null = null;
  try {
    const [flowsheetIds, rotationIds] = await Promise.all([
      opts.keyspaceSource.loadFlowsheetIds(),
      opts.keyspaceSource.loadRotationIds(),
    ]);
    loadedKeyspaceSizes = { flowsheet: flowsheetIds.size, rotation: rotationIds.size };
    keyspaces = { flowsheet: flowsheetIds, rotation: rotationIds };
    log('info', 'keyspace_loaded', 'keyspace source loaded', {
      flowsheet_keyspace_size: flowsheetIds.size,
      rotation_keyspace_size: rotationIds.size,
      min_keyspace_size: minKeyspaceSize,
    });
  } catch (error) {
    failure = { error };
    log('error', 'keyspace_load_failed', 'failed to load the legacy keyspace source', {
      error_message: errorMessage(error),
    });
    captureError(error, 'keyspace_load_failed');
  }

  // Refuse rather than trust a suspiciously small keyspace — see the module
  // doc's "Empty/truncated keyspace floor" note. A missing or truncated
  // LegacyKeyspaceSource file would otherwise anti-join nearly every row as
  // a ghost. Checked outside the load try/catch so this failure gets its
  // own distinct step/message instead of being folded into
  // `keyspace_load_failed` (the load itself succeeded; the *content* is
  // what's rejected).
  if (
    keyspaces &&
    loadedKeyspaceSizes &&
    minKeyspaceSize > 0 &&
    (loadedKeyspaceSizes.flowsheet < minKeyspaceSize || loadedKeyspaceSizes.rotation < minKeyspaceSize)
  ) {
    const sizeError = new Error(
      `Refusing to run: loaded keyspace is below the floor (flowsheet=${loadedKeyspaceSizes.flowsheet}, ` +
        `rotation=${loadedKeyspaceSizes.rotation}, floor=${minKeyspaceSize}). This almost always means the ` +
        'keyspace source file is missing, truncated, or pointed at the wrong path — not that tubafrenzy ' +
        'genuinely has that few surviving rows. Set GHOST_SWEEP_MIN_KEYSPACE_SIZE=0 to override for a ' +
        'deliberate tiny/empty-fixture run.'
    );
    failure = { error: sizeError };
    keyspaces = null;
    log('error', 'keyspace_too_small', sizeError.message, {
      flowsheet_keyspace_size: loadedKeyspaceSizes.flowsheet,
      rotation_keyspace_size: loadedKeyspaceSizes.rotation,
      min_keyspace_size: minKeyspaceSize,
    });
    captureError(sizeError, 'keyspace_too_small', {
      flowsheet_keyspace_size: loadedKeyspaceSizes.flowsheet,
      rotation_keyspace_size: loadedKeyspaceSizes.rotation,
    });
  }

  const runTarget = async (target: SweepTarget, afterId: number, keyspace: Set<number>): Promise<void> => {
    const totals = result[target];
    totals.last_id = afterId;

    let lastId = afterId;
    let wrote = false;
    while (true) {
      if (stopRequested || (await waitForQuietPeriod())) {
        result.stopped = true;
        break;
      }

      let rows: CandidateRow[];
      try {
        rows = await loadBatch(target, lastId, batchSize);
      } catch (error) {
        if (stopRequested) result.stopped = true;
        else failure = { error };
        break;
      }
      if (rows.length === 0) break;

      const batchStart = Date.now();
      const ghostIds: number[] = [];
      for (const row of rows) {
        totals.scanned += 1;
        if (keyspace.has(row.legacy_id)) continue; // still exists upstream — not a ghost
        totals.ghosts += 1;
        if (totals.sample.length < sampleSize) totals.sample.push(row.id);
        ghostIds.push(row.id);
      }

      // Truncated/mostly-wrong keyspace guard: the absolute keyspace floor
      // only catches an *empty* Set, not a keyspace that lost most of its ids
      // to a partial extraction. Once a full page has been scanned, if the
      // running ghost fraction exceeds the ceiling, refuse to keep going — a
      // healthy sweep clears a small residual, not the majority of a live
      // table. Checked before this page's DELETE so a truncated keyspace
      // trips on the first full page with zero rows removed, and evaluated in
      // dry-run too so it surfaces during the operator's dry-run review.
      if (maxGhostRatio < 1 && totals.scanned >= batchSize && totals.ghosts / totals.scanned > maxGhostRatio) {
        const ghostRatio = totals.ghosts / totals.scanned;
        const ratioError = new Error(
          `Refusing to continue: ${target} ghost fraction ${ghostRatio.toFixed(4)} exceeds ` +
            `GHOST_SWEEP_MAX_GHOST_RATIO=${maxGhostRatio} after ${totals.scanned} rows scanned ` +
            `(${totals.ghosts} flagged as ghosts). A healthy sweep clears a small residual; a majority-ghost ` +
            'scan almost always means the keyspace source is truncated or pointed at the wrong data. Set ' +
            'GHOST_SWEEP_MAX_GHOST_RATIO=1 to disable this guard for a deliberate large-sweep run.'
        );
        failure = { error: ratioError };
        log('error', 'ghost_ratio_exceeded', ratioError.message, {
          target,
          scanned: totals.scanned,
          ghosts: totals.ghosts,
          ghost_ratio: ghostRatio,
          max_ghost_ratio: maxGhostRatio,
        });
        captureError(ratioError, 'ghost_ratio_exceeded', {
          target,
          scanned: totals.scanned,
          ghosts: totals.ghosts,
        });
        break;
      }

      // rows are ORDER BY pk ASC, so the last row carries the page's max id.
      const batchMaxId = rows[rows.length - 1].id;

      if (!dryRun && ghostIds.length > 0) {
        try {
          const removed = await deleteBatchFn(target, ghostIds, deleteTimeoutMs);
          totals.removed += removed;
          wrote = true;
        } catch (error) {
          // The whole page failed to delete. Do NOT advance the resume
          // cursor — a re-run from the previous cursor re-selects and
          // re-tests these rows (idempotent).
          log('warn', 'db_error', `${target} batch DELETE failed at id>${lastId}`, {
            target,
            after_id: lastId,
            batch_rows: ghostIds.length,
            error_message: errorMessage(error),
          });
          captureError(error, 'db_error', { target, after_id: lastId, batch_rows: ghostIds.length });
          failure = { error };
          break;
        }
      }

      // Advance the cursor only after the page's delete commits (or in
      // dry-run / no-ghost pages, which wrote nothing to strand).
      lastId = batchMaxId;
      totals.last_id = batchMaxId;
      totals.batches += 1;

      log('info', 'batch_done', `${target} batch ${totals.batches} done`, {
        target,
        batch_index: totals.batches,
        wall_clock_ms: Date.now() - batchStart,
        last_id: lastId,
        page_rows: rows.length,
        page_ghosts: ghostIds.length,
        total_scanned: totals.scanned,
        total_ghosts: totals.ghosts,
        total_removed: totals.removed,
      });
    }

    // ANALYZE after a delete pass that actually wrote — stale planner stats
    // otherwise, per the bulk-update playbook. Skipped on dry-run / no-op.
    if (wrote) {
      try {
        await analyzeFn(target, analyzeTimeoutMs);
        log('info', 'analyzed', `${target} ANALYZE complete`, { target });
      } catch (error) {
        log('warn', 'analyze_error', `${target} ANALYZE failed`, {
          target,
          error_message: errorMessage(error),
        });
        captureError(error, 'analyze_error', { target });
        // A failed ANALYZE is not a data-correctness failure — the rows are
        // swept. Surface it loudly but don't fail the whole run over stats.
      }
    }

    // Post-run verification: re-scan the same [afterId, end] range this
    // target just swept and confirm zero ghosts remain — see the module
    // doc's "Post-run ghost-free verification" note (async commit can lose
    // a DELETE the main loop believed had committed). Only meaningful for a
    // clean execute finish that actually deleted: skipped on dry-run
    // (nothing was deleted to verify), on a stopped/failed run (an
    // incomplete sweep is expected to still have ghosts in its unswept
    // tail), and on a target that removed nothing (`wrote === false` — no
    // DELETE happened, so there is no lost-durability window to re-scan for,
    // and re-scanning the whole range would only burn a second full pass).
    if (!dryRun && !result.stopped && !failure && wrote) {
      try {
        const remaining = await countRemainingGhosts(target, afterId, keyspace, batchSize);
        if (remaining === null) {
          // SIGTERM landed during verification itself; leave `remaining`
          // at its -1 default rather than claim a count that never
          // finished, and let the stopped path own the summary.
          result.stopped = true;
        } else {
          totals.remaining = remaining;
          if (remaining > 0) {
            const verr = new Error(
              `${target}: ${remaining} ghost row(s) still present after --execute — a page's DELETE likely ` +
                'lost durability to a crash under async commit (DB_SYNCHRONOUS_COMMIT=off); re-run to sweep them.'
            );
            log('error', 'verification_failed', verr.message, { target, remaining });
            captureError(verr, 'verification_failed', { target, remaining });
            failure = failure ?? { error: verr };
          } else {
            log('info', 'verified', `${target} verified ghost-free`, { target });
          }
        }
      } catch (error) {
        if (stopRequested) {
          // A SIGTERM landed mid-verification and surfaced as a loadBatch
          // throw (a retry saw the stop flag and rethrew). Classify it as a
          // graceful stop, exactly as the main loop does at its own loadBatch
          // site — not a run failure — so the exit code matches the operator
          // action regardless of where in the scan the signal landed.
          result.stopped = true;
        } else {
          // A genuine verification-scan error (not a residue finding) is
          // treated like any other read failure this run couldn't recover
          // from.
          log('warn', 'verification_error', `${target} post-run verification failed to run`, {
            target,
            error_message: errorMessage(error),
          });
          captureError(error, 'verification_error', { target });
          failure = failure ?? { error };
        }
      }
    }
  };

  if (keyspaces) {
    try {
      await runTarget('flowsheet', flowsheetAfterId, keyspaces.flowsheet);
      if (!result.stopped && !failure) {
        await runTarget('rotation', rotationAfterId, keyspaces.rotation);
      }
    } catch (error) {
      // Defensive: the target loop catches its own errors, so this arm only
      // fires on a programming error. Preserve the summary either way.
      failure = { error };
    }
  }

  result.failed = failure !== null;

  // Summary span carrying numeric attributes (BS#1081 typing-trap
  // workaround, mirrored from streaming-url-remediation) — emitted even on
  // stop/fail so partial-run telemetry is queryable.
  Sentry.startSpan(
    {
      name: 'flowsheet_ghost_row_sweep.run.summary',
      attributes: {
        'sweep.dry_run': dryRun,
        'sweep.flowsheet.scanned': result.flowsheet.scanned,
        'sweep.flowsheet.ghosts': result.flowsheet.ghosts,
        'sweep.flowsheet.removed': result.flowsheet.removed,
        'sweep.flowsheet.last_id': result.flowsheet.last_id,
        'sweep.flowsheet.remaining': result.flowsheet.remaining,
        'sweep.rotation.scanned': result.rotation.scanned,
        'sweep.rotation.ghosts': result.rotation.ghosts,
        'sweep.rotation.removed': result.rotation.removed,
        'sweep.rotation.last_id': result.rotation.last_id,
        'sweep.rotation.remaining': result.rotation.remaining,
        'sweep.stopped': result.stopped,
        'sweep.failed': result.failed,
      },
    },
    () => {
      /* attributes set at creation */
    }
  );

  const step = failure ? 'failed' : result.stopped ? 'stopped' : 'finished';
  const level = failure ? 'error' : 'info';
  log(level, step, `${JOB_NAME} ${step}`, {
    dry_run: dryRun,
    flowsheet: { ...result.flowsheet },
    rotation: { ...result.rotation },
    stopped: result.stopped,
    failed: result.failed,
    ...(failure ? { error_message: errorMessage(failure.error) } : {}),
  });
  if (failure) {
    captureError(failure.error, 'failed', {
      flowsheet_last_id: result.flowsheet.last_id,
      rotation_last_id: result.rotation.last_id,
    });
  }

  return result;
};
