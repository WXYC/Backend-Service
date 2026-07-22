/**
 * Two-phase orchestrator for the apple-music-url-backfill remediation
 * (BS#1631).
 *
 * Phase A iterates `album_metadata`, phase B iterates `flowsheet` — album
 * first so the flowsheet phase's LML re-queries land on an already-warm
 * LML album cache. Candidates in both phases are rows where
 * `apple_music_url IS NULL` AND a positive match signal exists
 * (`discogs_url IS NOT NULL` OR the linked `library.on_streaming = true`)
 * — re-check likely-present albums, not the genuine-absence long tail.
 *
 * Per candidate: up to TWO LML lookups. The second fires only when the
 * first returned no Apple URL, after a configurable delay — it catches
 * LML#706's eventually-consistent streaming post-process, which returns
 * null on the first lookup and fills its cache in the background.
 *
 * Dry-run (the job default; see `resolveDryRun`) performs the same paced
 * lookups but NEVER calls the apply seam — candidate count and
 * would-change count come out of the summary log with zero writes.
 *
 * Dedup: an in-run URL cache keyed on normalized (artist, album, track).
 * The track component is load-bearing — LML's `apple_music_url` can be a
 * per-track verified `/song/<id>` URL (BS#1192), so an (artist, album)
 * key would leak one track's URL onto another row. Album-phase keys use
 * an empty track and therefore never collide with flowsheet keys.
 *
 * Resumability: id-cursor iteration per phase; `BACKFILL_ALBUM_AFTER_ID` /
 * `BACKFILL_FLOWSHEET_AFTER_ID` resume a stopped run from the summary
 * log's per-phase `last_id`. Re-runs are idempotent regardless — resolved
 * rows drop out of the WHERE (`apple_music_url IS NULL`) and the apply
 * seam's SQL guard makes a racing fill a counted no-op.
 *
 * Cooperative pause, SIGTERM stop, and loadBatch retry mirror
 * `jobs/flowsheet-reenrichment/orchestrate.ts`.
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
import { applyUpdate, extractAppleMusicUrl, type ApplyOutcome, type ApplyTarget } from './resolve.js';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'apple-music-url-backfill';

export const BATCH_SIZE = 100;

/**
 * Delay between the two passes. LML#706's background streaming
 * post-process typically fills the album cache within seconds of the
 * first lookup; 15 s clears it with headroom without doubling the
 * per-candidate wall clock the way a full re-sweep would.
 */
export const SECOND_PASS_DELAY_MS = 15_000;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ALBUM_METADATA_TABLE = sql.raw(`"${SCHEMA}"."album_metadata"`);
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/**
 * Retry budget for the per-batch SELECT — a transient RDS failover should
 * not abort a multi-hour drain. Same shape as flowsheet-reenrichment.
 */
const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000];

/**
 * Dry-run is the DEFAULT: writes require the explicit `--execute` flag.
 * `--dry-run` is accepted as an explicit no-op for self-documenting run
 * commands; passing both is a fat-finger worth failing fast on.
 */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'BACKFILL_BATCH_SIZE', BATCH_SIZE);

export const resolveSecondPassDelayMs = (raw: string | undefined = process.env.BACKFILL_SECOND_PASS_DELAY_MS): number =>
  requireNonNegativeInt(raw, 'BACKFILL_SECOND_PASS_DELAY_MS', SECOND_PASS_DELAY_MS, {
    unit: 'ms',
    note: 'Use 0 to fire the second pass immediately.',
  });

export const resolveMaxRowsPerTable = (raw: string | undefined = process.env.BACKFILL_MAX_ROWS_PER_TABLE): number =>
  requireNonNegativeInt(raw, 'BACKFILL_MAX_ROWS_PER_TABLE', 0, {
    note: 'Use 0 for unlimited; a positive cap bounds a sample/pilot run.',
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

export type LookupFn = (artist: string, album?: string, track?: string) => Promise<LookupResponse>;
export type ApplyFn = (target: ApplyTarget, id: number, url: string) => Promise<ApplyOutcome>;

type CandidateRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title?: string | null;
};

type CandidateOutcome = 'resolved' | 'would_resolve' | 'still_null' | 'skipped_non_null' | 'lml_error' | 'db_error';

export type PhaseTotals = {
  candidates: number;
  scanned: number;
  resolved: number;
  would_resolve: number;
  still_null: number;
  skipped_non_null: number;
  lml_error: number;
  db_error: number;
  cache_hits: number;
  second_pass_attempts: number;
  second_pass_resolved: number;
  last_id: number;
};

export type RunResult = {
  album_metadata: PhaseTotals;
  flowsheet: PhaseTotals;
  dryRun: boolean;
  stopped: boolean;
  /** True iff loadBatch retry exhaustion (or an uncaught loop error) ended
   * the run — job.ts maps this to process.exitCode=1. */
  failed: boolean;
};

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

/**
 * Normalized dedup key. Track is part of the key on purpose — see the
 * module docblock (BS#1192: apple_music_url can be per-track).
 */
const normalize = (s: string | null | undefined): string => (s ?? '').trim().normalize('NFKC').toLowerCase();
const cacheKey = (artist: string, album: string | null | undefined, track: string | null | undefined): string =>
  normalize(artist) + '\0' + normalize(album) + '\0' + normalize(track);

/**
 * Shared WHERE fragments so the phase-start COUNT and the batch SELECT can
 * never drift apart (the count IS the "SELECT with the same predicate
 * first" the issue's data-safety constraint asks for).
 */
const albumWhere = (afterId: number) => sql`
  WHERE am."apple_music_url" IS NULL
    AND (am."discogs_url" IS NOT NULL OR l."on_streaming" = true)
    AND COALESCE(a."artist_name", l."artist_name") IS NOT NULL
    AND am."album_id" > ${afterId}
`;

const flowsheetWhere = (afterId: number) => sql`
  WHERE f."entry_type" = 'track'
    AND f."apple_music_url" IS NULL
    AND (f."discogs_url" IS NOT NULL OR l."on_streaming" = true)
    AND f."artist_name" IS NOT NULL
    AND f."id" > ${afterId}
`;

const albumFrom = sql`
  FROM ${ALBUM_METADATA_TABLE} am
  JOIN ${LIBRARY_TABLE} l ON l."id" = am."album_id"
  LEFT JOIN ${ARTISTS_TABLE} a ON l."artist_id" = a."id"
`;

const flowsheetFrom = sql`
  FROM ${FLOWSHEET_TABLE} f
  LEFT JOIN ${LIBRARY_TABLE} l ON l."id" = f."album_id"
`;

const countCandidates = async (target: ApplyTarget, afterId: number): Promise<number> => {
  const query =
    target === 'album_metadata'
      ? sql`SELECT COUNT(*)::int AS count ${albumFrom} ${albumWhere(afterId)}`
      : sql`SELECT COUNT(*)::int AS count ${flowsheetFrom} ${flowsheetWhere(afterId)}`;
  const rows = (await db.execute(query)) as unknown as Array<{ count: number | string }>;
  return Number(rows?.[0]?.count ?? 0);
};

const loadBatchOnce = async (target: ApplyTarget, afterId: number, batchSize: number): Promise<CandidateRow[]> => {
  const query =
    target === 'album_metadata'
      ? sql`
          SELECT
            am."album_id" AS "id",
            COALESCE(a."artist_name", l."artist_name") AS "artist_name",
            l."album_title" AS "album_title"
          ${albumFrom}
          ${albumWhere(afterId)}
          ORDER BY am."album_id" ASC
          LIMIT ${batchSize}
        `
      : sql`
          SELECT
            f."id",
            f."artist_name",
            f."album_title",
            f."track_title"
          ${flowsheetFrom}
          ${flowsheetWhere(afterId)}
          ORDER BY f."id" ASC
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
const loadBatch = async (target: ApplyTarget, afterId: number, batchSize: number): Promise<CandidateRow[]> => {
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

const emptyPhaseTotals = (): PhaseTotals => ({
  candidates: 0,
  scanned: 0,
  resolved: 0,
  would_resolve: 0,
  still_null: 0,
  skipped_non_null: 0,
  lml_error: 0,
  db_error: 0,
  cache_hits: 0,
  second_pass_attempts: 0,
  second_pass_resolved: 0,
  last_id: 0,
});

type PhaseDeps = {
  lookup: LookupFn;
  apply: ApplyFn;
  dryRun: boolean;
  secondPassDelayMs: number;
  urlCache: Map<string, string | null>;
};

/**
 * Drive a single candidate through (cached) lookup → two-pass resolution →
 * apply. Catches lookup AND apply errors so one bad row cannot abort the
 * run. Mutates the phase totals' cache/second-pass counters; the caller
 * owns scanned/last_id and the outcome counter.
 */
const processCandidate = async (
  target: ApplyTarget,
  row: CandidateRow,
  totals: PhaseTotals,
  deps: PhaseDeps
): Promise<CandidateOutcome> => {
  const key = cacheKey(row.artist_name, row.album_title, row.track_title);

  let url: string | null;
  if (deps.urlCache.has(key)) {
    totals.cache_hits += 1;
    url = deps.urlCache.get(key) ?? null;
  } else {
    const album = row.album_title ?? undefined;
    const track = row.track_title ?? undefined;
    try {
      url = extractAppleMusicUrl(await deps.lookup(row.artist_name, album, track));
      if (url === null) {
        // Second pass: LML#706's post-process fills the album cache in the
        // background after the first lookup; give it a beat and re-ask.
        totals.second_pass_attempts += 1;
        await stopAwareSleep(deps.secondPassDelayMs);
        url = extractAppleMusicUrl(await deps.lookup(row.artist_name, album, track));
        if (url !== null) totals.second_pass_resolved += 1;
      }
    } catch (error) {
      log('warn', 'lml_error', `LML lookup failed for ${target} id=${row.id}`, {
        target,
        row_id: row.id,
        error_message: errorMessage(error),
      });
      captureError(error, 'lml_error', {
        target,
        row_id: row.id,
        artist: row.artist_name,
        album: row.album_title ?? null,
        track: row.track_title ?? null,
      });
      return 'lml_error';
    }
    deps.urlCache.set(key, url);
  }

  if (url === null) return 'still_null';
  if (deps.dryRun) return 'would_resolve';

  try {
    return await deps.apply(target, row.id, url);
  } catch (error) {
    log('warn', 'db_error', `${target} UPDATE failed for id=${row.id}`, {
      target,
      row_id: row.id,
      error_message: errorMessage(error),
    });
    captureError(error, 'db_error', { target, row_id: row.id, url });
    return 'db_error';
  }
};

export const runBackfill = async (opts: {
  lookup: LookupFn;
  apply?: ApplyFn;
  dryRun: boolean;
  batchSize?: number;
  maxRowsPerTable?: number;
  secondPassDelayMs?: number;
  albumAfterId?: number;
  flowsheetAfterId?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
}): Promise<RunResult> => {
  const dryRun = opts.dryRun;
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const maxRowsPerTable = opts.maxRowsPerTable ?? resolveMaxRowsPerTable();
  const secondPassDelayMs = opts.secondPassDelayMs ?? resolveSecondPassDelayMs();
  const albumAfterId =
    opts.albumAfterId ?? resolveAfterId('BACKFILL_ALBUM_AFTER_ID', process.env.BACKFILL_ALBUM_AFTER_ID);
  const flowsheetAfterId =
    opts.flowsheetAfterId ?? resolveAfterId('BACKFILL_FLOWSHEET_AFTER_ID', process.env.BACKFILL_FLOWSHEET_AFTER_ID);
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  const deps: PhaseDeps = {
    lookup: opts.lookup,
    apply: opts.apply ?? applyUpdate,
    dryRun,
    secondPassDelayMs,
    urlCache: new Map<string, string | null>(),
  };

  // On probe error: log + capture + assume no activity. A transient RDS
  // error in the probe SELECT shouldn't abort the drain.
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
    second_pass_delay_ms: secondPassDelayMs,
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
  // Pre-seed the resume cursors so a run stopped before a phase starts
  // still logs the operator's own cursor back out (not a misleading 0).
  result.album_metadata.last_id = albumAfterId;
  result.flowsheet.last_id = flowsheetAfterId;
  let failure: { error: unknown } | null = null;

  const runPhase = async (target: ApplyTarget, afterId: number): Promise<void> => {
    const totals = result[target];
    totals.last_id = afterId;

    totals.candidates = await countCandidates(target, afterId);
    log('info', 'phase_started', `${target} phase: ${totals.candidates} candidates`, {
      target,
      candidates: totals.candidates,
      after_id: afterId,
    });

    let lastId = afterId;
    let batchIndex = 0;
    while (true) {
      if (stopRequested || (await waitForQuietPeriod())) {
        result.stopped = true;
        return;
      }
      if (maxRowsPerTable > 0 && totals.scanned >= maxRowsPerTable) {
        log('info', 'phase_capped', `${target} phase capped at ${maxRowsPerTable} rows`, {
          target,
          max_rows_per_table: maxRowsPerTable,
          last_id: lastId,
        });
        return;
      }

      let rows: CandidateRow[];
      try {
        rows = await loadBatch(target, lastId, batchSize);
      } catch (error) {
        if (stopRequested) {
          result.stopped = true;
        } else {
          failure = { error };
        }
        return;
      }
      if (rows.length === 0) return;

      batchIndex += 1;
      const batchStart = Date.now();
      const before = { ...totals };

      for (const row of rows) {
        const outcome = await processCandidate(target, row, totals, deps);
        totals.scanned += 1;
        totals[outcome] += 1;
        lastId = row.id;
        totals.last_id = row.id;
        if (stopRequested) {
          result.stopped = true;
          break;
        }
        if (maxRowsPerTable > 0 && totals.scanned >= maxRowsPerTable) break;
      }

      log('info', 'batch_done', `${target} batch ${batchIndex} done`, {
        target,
        batch_index: batchIndex,
        wall_clock_ms: Date.now() - batchStart,
        last_id: lastId,
        scanned: totals.scanned - before.scanned,
        resolved: totals.resolved - before.resolved,
        would_resolve: totals.would_resolve - before.would_resolve,
        still_null: totals.still_null - before.still_null,
        skipped_non_null: totals.skipped_non_null - before.skipped_non_null,
        lml_error: totals.lml_error - before.lml_error,
        db_error: totals.db_error - before.db_error,
        total_scanned: totals.scanned,
      });

      if (result.stopped) return;
    }
  };

  try {
    await runPhase('album_metadata', albumAfterId);
    if (!result.stopped && !failure) {
      await runPhase('flowsheet', flowsheetAfterId);
    }
  } catch (error) {
    // Defensive: processCandidate catches its own errors, so this arm only
    // fires on a programming error. Preserve the summary either way.
    failure = { error };
  } finally {
    result.failed = failure !== null;

    // Summary span carrying numeric attributes (BS#1081 typing-trap
    // workaround) — emitted even on stop/fail so partial-run telemetry is
    // queryable in Sentry's trace explorer.
    Sentry.startSpan(
      {
        name: 'apple_music_url_backfill.run.summary',
        attributes: {
          'backfill.dry_run': dryRun,
          'backfill.album.candidates': result.album_metadata.candidates,
          'backfill.album.resolved': result.album_metadata.resolved,
          'backfill.album.would_resolve': result.album_metadata.would_resolve,
          'backfill.album.still_null': result.album_metadata.still_null,
          'backfill.album.last_id': result.album_metadata.last_id,
          'backfill.flowsheet.candidates': result.flowsheet.candidates,
          'backfill.flowsheet.resolved': result.flowsheet.resolved,
          'backfill.flowsheet.would_resolve': result.flowsheet.would_resolve,
          'backfill.flowsheet.still_null': result.flowsheet.still_null,
          'backfill.flowsheet.last_id': result.flowsheet.last_id,
          'backfill.stopped': result.stopped,
          'backfill.failed': result.failed,
        },
      },
      () => {
        /* attributes set at creation */
      }
    );

    // Distinct steps so a runbook jq filter can differentiate:
    //   'finished' — both phases drained (or capped) cleanly
    //   'stopped'  — SIGTERM caused a clean early break (resume via last_id)
    //   'failed'   — retry exhaustion / uncaught error; last_id still logged
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
