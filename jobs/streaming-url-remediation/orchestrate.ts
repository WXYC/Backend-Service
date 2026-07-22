/**
 * Two-phase orchestrator for the streaming-URL remediation (BS#1715).
 *
 * The ingestion guard (#1712) and the read-time serve-seam guard (#1714) stop
 * new mislabeled streaming URLs and hide the persisted ones from live reads,
 * but BS persistence is fill-only so rows written *before* the guard shipped
 * keep a foreign-host value in `spotify_url` / `apple_music_url` forever. This
 * job is the durable data fix: it scans both tables for rows whose stored host
 * doesn't match the column and rewrites each row through
 * `computeStreamingUrlFix` (transform.ts) — nulling an unrecoverable foreign
 * value and relocating a real link that landed in the wrong slot.
 *
 * Shape vs. the BS#1672 streaming-url-upgrade sibling: that job re-queries LML
 * to upgrade *search-shaped* URLs (correct provider, search page); this job
 * needs NO LML — the correct value is already present in the row (or nowhere),
 * so the fix is a pure local host-guard arbitration and writes are BATCHED (one
 * VALUES-join UPDATE per page) rather than one guarded UPDATE per row. The two
 * never fight: a spotify-search URL is spotify-hosted (this job's net skips it)
 * and a foreign-host URL isn't search-shaped (the upgrade job's net skips it).
 *
 * Coarse candidate net (SQL): `spotify_url IS NOT NULL AND spotify_url NOT
 * ILIKE '%spotify.com%'` OR the apple mirror. This is a superset of what the
 * per-row guard rejects for the whole-domain pollution in prod; the transform
 * is the true arbiter within the net. Because every net-matched row necessarily
 * changes (a value that fails `NOT ILIKE '%spotify.com%'` can never be a
 * Spotify host), a complete `--execute` run leaves exactly zero candidates —
 * which the post-run verification asserts.
 *
 * Dry-run (the job default; see `resolveDryRun`) performs the same paged scan
 * and reports scanned / changed counts plus a before→after sample with zero
 * writes.
 *
 * Batched writes get an `ANALYZE` after each table's write pass — the flowsheet
 * bulk-update playbook (docs/bulk-update-playbook.md) mandates it because a
 * large UPDATE leaves the planner's stats stale. Resumability is id-cursor per
 * phase (`REMEDIATION_ALBUM_AFTER_ID` / `REMEDIATION_FLOWSHEET_AFTER_ID`); the
 * resume cursor advances only after a page's write commits, so a mid-run write
 * failure never strands unwritten rows behind the logged cursor. Re-runs are
 * idempotent: a fixed row is host-correct and drops out of the net.
 *
 * Cooperative pause, SIGTERM stop, and loadBatch retry mirror
 * `jobs/streaming-url-upgrade/orchestrate.ts`.
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
import { computeStreamingUrlFix, SPOTIFY_HOST_SUBSTR, APPLE_HOST_SUBSTR } from './transform.js';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'streaming-url-remediation';

/**
 * Page size for both the candidate SELECT and the VALUES-join UPDATE. 5000 is
 * the flowsheet bulk-update playbook default — large enough to amortize the
 * per-statement overhead, small enough that one page's heap rewrite + tsvector
 * regen + CDC pg_notify fan-out stays a bounded unit of work.
 */
export const BATCH_SIZE = 5000;

/** How many before→after rows the dry-run (and execute) summary carries per phase. */
export const SAMPLE_SIZE_DEFAULT = 20;

/**
 * Per-operation statement-timeout ceilings. The job's connection already runs
 * with `DB_STATEMENT_TIMEOUT_MS=300000` (Dockerfile), but a `SET LOCAL` around
 * each write / ANALYZE makes the ceiling explicit and independently tunable.
 */
export const UPDATE_TIMEOUT_MS_DEFAULT = 300_000;
export const ANALYZE_TIMEOUT_MS_DEFAULT = 300_000;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ALBUM_METADATA_TABLE = sql.raw(`"${SCHEMA}"."album_metadata"`);
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);

/** ILIKE net patterns — a value NOT containing the apex substring can't be that host. */
const SPOTIFY_NET_PATTERN = `%${SPOTIFY_HOST_SUBSTR}%`;
const APPLE_NET_PATTERN = `%${APPLE_HOST_SUBSTR}%`;

const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000];

export type RemediationTarget = 'album_metadata' | 'flowsheet';

interface TargetMeta {
  table: ReturnType<typeof sql.raw>;
  /** Serial PK — doubles as the id-cursor column. */
  pkColumn: 'album_id' | 'id';
  /** Table alias used in the net predicate / SELECT. */
  alias: 'am' | 'f';
  /**
   * Whether the write bumps `updated_at`. album_metadata follows the writer
   * convention (apps/enrichment-worker/enrich.ts). flowsheet's BEFORE UPDATE
   * trigger `bump_flowsheet_updated_at` (migration 0084) owns its own stamp,
   * so the job must NOT set it there.
   */
  bumpUpdatedAt: boolean;
}

const TARGET_META: Record<RemediationTarget, TargetMeta> = {
  album_metadata: { table: ALBUM_METADATA_TABLE, pkColumn: 'album_id', alias: 'am', bumpUpdatedAt: true },
  flowsheet: { table: FLOWSHEET_TABLE, pkColumn: 'id', alias: 'f', bumpUpdatedAt: false },
};

const TARGETS: readonly RemediationTarget[] = ['album_metadata', 'flowsheet'] as const;

/**
 * The coarse candidate net, shared by the phase-start COUNT, the batch SELECT,
 * and the post-run verification so the three can never drift. A row is a
 * candidate iff a non-null `spotify_url` is not Spotify-hosted OR a non-null
 * `apple_music_url` is not Apple-hosted (case-insensitive substring test).
 */
const netPredicate = (alias: 'am' | 'f') => sql`(
    (${sql.raw(`${alias}."spotify_url"`)} IS NOT NULL AND ${sql.raw(`${alias}."spotify_url"`)} NOT ILIKE ${SPOTIFY_NET_PATTERN})
    OR (${sql.raw(`${alias}."apple_music_url"`)} IS NOT NULL AND ${sql.raw(`${alias}."apple_music_url"`)} NOT ILIKE ${APPLE_NET_PATTERN})
  )`;

interface CandidateRow {
  id: number;
  spotify_url: string | null;
  apple_music_url: string | null;
}

/** A computed fix ready to write: the row PK plus its host-correct columns. */
export interface FixedRow {
  id: number;
  spotify_url: string | null;
  apple_music_url: string | null;
}

interface SampleEntry {
  id: number;
  before: { spotify_url: string | null; apple_music_url: string | null };
  after: { spotify_url: string | null; apple_music_url: string | null };
}

export type PhaseTotals = {
  /** Rows matching the net at phase start (the SELECT-count the data-safety rule asks for). */
  candidates: number;
  scanned: number;
  /** Rows the transform flagged as needing a write. */
  changed: number;
  /** Rows actually UPDATEd (execute only; 0 in dry-run). */
  written: number;
  spotify_cleared: number;
  spotify_recovered: number;
  apple_cleared: number;
  apple_recovered: number;
  batches: number;
  last_id: number;
  /** Post-run net re-count (execute + full-scope only); -1 when not verified. */
  remaining: number;
  sample: SampleEntry[];
};

export type RunResult = {
  album_metadata: PhaseTotals;
  flowsheet: PhaseTotals;
  dryRun: boolean;
  stopped: boolean;
  /** True iff a write failure, retry exhaustion, or a failed verification ended the run. */
  failed: boolean;
};

/** The batched-write seam — injectable so `runRemediation` tests don't route writes through the db mock. */
export type ApplyBatchFn = (target: RemediationTarget, fixes: FixedRow[], updateTimeoutMs: number) => Promise<number>;
/** The post-pass ANALYZE seam — injectable for the same reason. */
export type AnalyzeFn = (target: RemediationTarget, analyzeTimeoutMs: number) => Promise<void>;

/**
 * Dry-run is the DEFAULT: writes require the explicit `--execute` flag.
 * `--dry-run` is accepted as an explicit no-op; passing both fails fast.
 */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveBatchSize = (raw: string | undefined = process.env.REMEDIATION_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'REMEDIATION_BATCH_SIZE', BATCH_SIZE);

export const resolveMaxRowsPerTable = (raw: string | undefined = process.env.REMEDIATION_MAX_ROWS_PER_TABLE): number =>
  requireNonNegativeInt(raw, 'REMEDIATION_MAX_ROWS_PER_TABLE', 0, {
    note: 'Use 0 for the full table; a positive cap (rounded up to a batch boundary) bounds a pilot run and skips post-run verification.',
  });

export const resolveUpdateTimeoutMs = (raw: string | undefined = process.env.REMEDIATION_UPDATE_TIMEOUT_MS): number =>
  requirePositiveInt(raw, 'REMEDIATION_UPDATE_TIMEOUT_MS', UPDATE_TIMEOUT_MS_DEFAULT);

export const resolveAnalyzeTimeoutMs = (raw: string | undefined = process.env.REMEDIATION_ANALYZE_TIMEOUT_MS): number =>
  requirePositiveInt(raw, 'REMEDIATION_ANALYZE_TIMEOUT_MS', ANALYZE_TIMEOUT_MS_DEFAULT);

export const resolveSampleSize = (raw: string | undefined = process.env.REMEDIATION_SAMPLE_SIZE): number =>
  requireNonNegativeInt(raw, 'REMEDIATION_SAMPLE_SIZE', SAMPLE_SIZE_DEFAULT, {
    note: 'Use 0 to omit the before→after sample from the summary.',
  });

export const resolveAfterId = (envName: string, raw: string | undefined): number =>
  requireNonNegativeInt(raw, envName, 0, {
    note: 'Resume cursor — the summary log of the previous run carries the per-phase last_id.',
  });

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable the cooperative pause.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_PAUSE_MS', LIVE_ACTIVITY_PAUSE_MS_DEFAULT, { unit: 'ms' });

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

const countCandidates = async (target: RemediationTarget, afterId: number): Promise<number> => {
  const { table, pkColumn, alias } = TARGET_META[target];
  const query = sql`
    SELECT COUNT(*)::int AS count
    FROM ${table} ${sql.raw(alias)}
    WHERE ${netPredicate(alias)}
      AND ${sql.raw(`${alias}."${pkColumn}"`)} > ${afterId}
  `;
  const rows = (await db.execute(query)) as unknown as Array<{ count: number | string }>;
  return Number(rows?.[0]?.count ?? 0);
};

const loadBatchOnce = async (
  target: RemediationTarget,
  afterId: number,
  batchSize: number
): Promise<CandidateRow[]> => {
  const { table, pkColumn, alias } = TARGET_META[target];
  const pkRef = sql.raw(`${alias}."${pkColumn}"`);
  const query = sql`
    SELECT
      ${pkRef} AS "id",
      ${sql.raw(`${alias}."spotify_url"`)} AS "spotify_url",
      ${sql.raw(`${alias}."apple_music_url"`)} AS "apple_music_url"
    FROM ${table} ${sql.raw(alias)}
    WHERE ${netPredicate(alias)}
      AND ${pkRef} > ${afterId}
    ORDER BY ${pkRef} ASC
    LIMIT ${batchSize}
  `;
  const rows = (await db.execute(query)) as unknown as CandidateRow[];
  return rows ?? [];
};

/**
 * loadBatch with transient-error retry. Honors stopRequested so shutdown isn't
 * blocked by retry backoffs; exhausting retries throws the most recent error
 * (the caller distinguishes stop from failure via the flag).
 */
const loadBatch = async (target: RemediationTarget, afterId: number, batchSize: number): Promise<CandidateRow[]> => {
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

/**
 * Apply one page of fixes in a single VALUES-join UPDATE inside a raised-timeout
 * transaction. Only changed rows reach here (the caller filters on
 * `fix.changed`). Returns the number of rows the UPDATE actually touched.
 */
export const applyBatch = async (
  target: RemediationTarget,
  fixes: FixedRow[],
  updateTimeoutMs: number
): Promise<number> => {
  if (fixes.length === 0) return 0;
  const { table, pkColumn, bumpUpdatedAt } = TARGET_META[target];
  const valuesRows = fixes.map((r) => sql`(${r.id}::int, ${r.spotify_url}::varchar, ${r.apple_music_url}::varchar)`);
  const values = sql.join(valuesRows, sql`, `);
  const setUpdatedAt = bumpUpdatedAt ? sql`, "updated_at" = NOW()` : sql``;
  const updateSql = sql`
    UPDATE ${table} AS t
    SET "spotify_url" = v."spotify_url",
        "apple_music_url" = v."apple_music_url"${setUpdatedAt}
    FROM (VALUES ${values}) AS v("id", "spotify_url", "apple_music_url")
    WHERE t.${sql.raw(`"${pkColumn}"`)} = v."id"
  `;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(updateTimeoutMs))}`);
    return tx.execute(updateSql);
  });
  return Number((result as { count?: number }).count ?? fixes.length);
};

/**
 * ANALYZE a table in its own raised-timeout transaction after its write pass —
 * the flowsheet bulk-update playbook rule. ANALYZE is transaction-safe (unlike
 * VACUUM); the SET LOCAL scopes the timeout to this transaction only.
 */
export const analyzeTable = async (target: RemediationTarget, analyzeTimeoutMs: number): Promise<void> => {
  const { table } = TARGET_META[target];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(analyzeTimeoutMs))}`);
    await tx.execute(sql`ANALYZE ${table}`);
  });
};

const emptyPhaseTotals = (): PhaseTotals => ({
  candidates: 0,
  scanned: 0,
  changed: 0,
  written: 0,
  spotify_cleared: 0,
  spotify_recovered: 0,
  apple_cleared: 0,
  apple_recovered: 0,
  batches: 0,
  last_id: 0,
  remaining: -1,
  sample: [],
});

export const runRemediation = async (opts: {
  dryRun: boolean;
  batchSize?: number;
  maxRowsPerTable?: number;
  updateTimeoutMs?: number;
  analyzeTimeoutMs?: number;
  sampleSize?: number;
  albumAfterId?: number;
  flowsheetAfterId?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  /** Injected write path (tests only); defaults to the module `applyBatch`. */
  applyBatch?: ApplyBatchFn;
  /** Injected ANALYZE path (tests only); defaults to the module `analyzeTable`. */
  analyzeTable?: AnalyzeFn;
}): Promise<RunResult> => {
  const dryRun = opts.dryRun;
  const applyBatchFn = opts.applyBatch ?? applyBatch;
  const analyzeFn = opts.analyzeTable ?? analyzeTable;
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const maxRowsPerTable = opts.maxRowsPerTable ?? resolveMaxRowsPerTable();
  const updateTimeoutMs = opts.updateTimeoutMs ?? resolveUpdateTimeoutMs();
  const analyzeTimeoutMs = opts.analyzeTimeoutMs ?? resolveAnalyzeTimeoutMs();
  const sampleSize = opts.sampleSize ?? resolveSampleSize();
  const albumAfterId =
    opts.albumAfterId ?? resolveAfterId('REMEDIATION_ALBUM_AFTER_ID', process.env.REMEDIATION_ALBUM_AFTER_ID);
  const flowsheetAfterId =
    opts.flowsheetAfterId ??
    resolveAfterId('REMEDIATION_FLOWSHEET_AFTER_ID', process.env.REMEDIATION_FLOWSHEET_AFTER_ID);
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  // On probe error: log + capture + assume no activity. A transient RDS error
  // in the probe SELECT shouldn't abort the drain.
  const safeProbe = async (): Promise<boolean> => {
    try {
      return await probe(liveActivityLookbackSeconds);
    } catch (error) {
      log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
        error_message: errorMessage(error),
      });
      captureError(error, 'probe_error');
      return false;
    }
  };

  // Returns true iff the run should stop (SIGTERM observed during the wait).
  const waitForQuietPeriod = async (): Promise<boolean> => {
    if (liveActivityLookbackSeconds <= 0) return false;
    let active = await safeProbe();
    while (active) {
      if (stopRequested) return true;
      log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
        lookback_seconds: liveActivityLookbackSeconds,
        pause_ms: liveActivityPauseMs,
      });
      await stopAwareSleep(liveActivityPauseMs);
      active = await safeProbe();
    }
    return stopRequested;
  };

  log('info', 'started', `${JOB_NAME} starting`, {
    dry_run: dryRun,
    batch_size: batchSize,
    max_rows_per_table: maxRowsPerTable,
    update_timeout_ms: updateTimeoutMs,
    analyze_timeout_ms: analyzeTimeoutMs,
    sample_size: sampleSize,
    album_after_id: albumAfterId,
    flowsheet_after_id: flowsheetAfterId,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
  });

  const result: RunResult = {
    album_metadata: emptyPhaseTotals(),
    flowsheet: emptyPhaseTotals(),
    dryRun,
    stopped: false,
    failed: false,
  };
  // Pre-seed resume cursors so a run stopped before a phase starts still logs
  // the operator's own cursor back out (not a misleading 0).
  result.album_metadata.last_id = albumAfterId;
  result.flowsheet.last_id = flowsheetAfterId;
  let failure: { error: unknown } | null = null;

  const runPhase = async (target: RemediationTarget, afterId: number): Promise<void> => {
    const totals = result[target];
    totals.last_id = afterId;
    totals.candidates = await countCandidates(target, afterId);
    log('info', 'phase_started', `${target} phase: ${totals.candidates} candidates`, {
      target,
      candidates: totals.candidates,
      after_id: afterId,
    });

    let lastId = afterId;
    let wrote = false;
    while (true) {
      if (stopRequested || (await waitForQuietPeriod())) {
        result.stopped = true;
        break;
      }
      if (maxRowsPerTable > 0 && totals.scanned >= maxRowsPerTable) {
        log('info', 'phase_capped', `${target} phase capped at ${maxRowsPerTable} rows`, {
          target,
          max_rows_per_table: maxRowsPerTable,
          last_id: lastId,
        });
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
      const fixes: FixedRow[] = [];
      for (const row of rows) {
        totals.scanned += 1;
        const fix = computeStreamingUrlFix(row);
        if (!fix.changed) continue; // defensive: every net row changes, but never wedge on a no-op
        totals.changed += 1;
        if (row.spotify_url !== null && fix.spotify_url === null) totals.spotify_cleared += 1;
        if (fix.spotify_url !== null && fix.spotify_url !== row.spotify_url) totals.spotify_recovered += 1;
        if (row.apple_music_url !== null && fix.apple_music_url === null) totals.apple_cleared += 1;
        if (fix.apple_music_url !== null && fix.apple_music_url !== row.apple_music_url) totals.apple_recovered += 1;
        if (totals.sample.length < sampleSize) {
          totals.sample.push({
            id: row.id,
            before: { spotify_url: row.spotify_url, apple_music_url: row.apple_music_url },
            after: { spotify_url: fix.spotify_url, apple_music_url: fix.apple_music_url },
          });
        }
        fixes.push({ id: row.id, spotify_url: fix.spotify_url, apple_music_url: fix.apple_music_url });
      }

      // rows are ORDER BY pk ASC, so the last row carries the page's max id.
      const batchMaxId = rows[rows.length - 1].id;

      if (!dryRun && fixes.length > 0) {
        try {
          const written = await applyBatchFn(target, fixes, updateTimeoutMs);
          totals.written += written;
          wrote = true;
        } catch (error) {
          // The whole page failed to write. Do NOT advance the resume cursor —
          // a re-run from the previous cursor re-selects these rows (idempotent).
          log('warn', 'db_error', `${target} batch UPDATE failed at id>${lastId}`, {
            target,
            after_id: lastId,
            batch_rows: fixes.length,
            error_message: errorMessage(error),
          });
          captureError(error, 'db_error', { target, after_id: lastId, batch_rows: fixes.length });
          failure = { error };
          break;
        }
      }

      // Advance the cursor only after the page's write commits (or in dry-run /
      // no-fix pages, which wrote nothing to strand).
      lastId = batchMaxId;
      totals.last_id = batchMaxId;
      totals.batches += 1;

      log('info', 'batch_done', `${target} batch ${totals.batches} done`, {
        target,
        batch_index: totals.batches,
        wall_clock_ms: Date.now() - batchStart,
        last_id: lastId,
        page_rows: rows.length,
        page_changed: fixes.length,
        total_scanned: totals.scanned,
        total_changed: totals.changed,
        total_written: totals.written,
      });
    }

    // ANALYZE after a write pass that actually wrote — stale planner stats
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
        // fixed. Surface it loudly but don't fail the whole run over stats.
      }
    }
  };

  try {
    await runPhase('album_metadata', albumAfterId);
    if (!result.stopped && !failure) {
      await runPhase('flowsheet', flowsheetAfterId);
    }

    // Post-run verification: a complete execute run must leave zero candidates
    // (every net row necessarily changes). Skipped for dry-run, a stopped or
    // failed run, or a capped pilot (where residual candidates are expected).
    if (!dryRun && !result.stopped && !failure && maxRowsPerTable === 0) {
      for (const target of TARGETS) {
        const remaining = await countCandidates(target, 0);
        result[target].remaining = remaining;
        if (remaining > 0) {
          log('error', 'verification_failed', `${target} still has ${remaining} mislabeled row(s) after remediation`, {
            target,
            remaining,
          });
          const verr = new Error(`${target}: ${remaining} row(s) still have a non-host-matching streaming URL`);
          captureError(verr, 'verification_failed', { target, remaining });
          failure = failure ?? { error: verr };
        }
      }
    }
  } catch (error) {
    // Defensive: the phase loop catches its own errors, so this arm only fires
    // on a programming error. Preserve the summary either way.
    failure = { error };
  } finally {
    result.failed = failure !== null;

    // Summary span carrying numeric attributes (BS#1081 typing-trap workaround)
    // — emitted even on stop/fail so partial-run telemetry is queryable.
    Sentry.startSpan(
      {
        name: 'streaming_url_remediation.run.summary',
        attributes: {
          'remediation.dry_run': dryRun,
          'remediation.album.candidates': result.album_metadata.candidates,
          'remediation.album.changed': result.album_metadata.changed,
          'remediation.album.written': result.album_metadata.written,
          'remediation.album.remaining': result.album_metadata.remaining,
          'remediation.album.last_id': result.album_metadata.last_id,
          'remediation.flowsheet.candidates': result.flowsheet.candidates,
          'remediation.flowsheet.changed': result.flowsheet.changed,
          'remediation.flowsheet.written': result.flowsheet.written,
          'remediation.flowsheet.remaining': result.flowsheet.remaining,
          'remediation.flowsheet.last_id': result.flowsheet.last_id,
          'remediation.stopped': result.stopped,
          'remediation.failed': result.failed,
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
      album_metadata: { ...result.album_metadata },
      flowsheet: { ...result.flowsheet },
      stopped: result.stopped,
      failed: result.failed,
      ...(failure ? { error_message: errorMessage(failure.error) } : {}),
    });
    if (failure) {
      captureError(failure.error, 'failed', {
        album_last_id: result.album_metadata.last_id,
        flowsheet_last_id: result.flowsheet.last_id,
      });
    }
  }

  return result;
};
