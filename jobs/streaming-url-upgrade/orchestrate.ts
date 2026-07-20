/**
 * Two-phase orchestrator for the streaming-url-upgrade remediation
 * (BS#1672).
 *
 * Phase A iterates `album_metadata`, phase B iterates `flowsheet` — album
 * first so the flowsheet phase's LML re-queries land on an already-warm LML
 * album cache. A candidate in either phase is a row whose `spotify_url` OR
 * `bandcamp_url` currently holds a provider *search* URL (LIKE the exact
 * `@wxyc/metadata` search prefix; see resolve.ts SERVICE_CONFIGS). This is a
 * shape-driven cohort, not the absence-driven one the apple backfill used —
 * no `IS NULL` / discogs signal.
 *
 * Per candidate: one LML lookup (cached), then up to a SECOND lookup that
 * fires only when the first returned no verified URL for any still-pending
 * column — it catches LML#706's eventually-consistent streaming
 * post-process. A single lookup can upgrade BOTH columns on one row; each
 * column is a separate guarded UPDATE (resolve.ts `applyUpgrade`) so a raced
 * write to one never blocks the other.
 *
 * Dry-run (the job default; see `resolveDryRun`) performs the same paced
 * lookups but NEVER calls the apply seam — candidate and would-upgrade
 * counts come out of the summary log with zero writes.
 *
 * Never-downgrade: `extractStreamingUrls` drops a value that is empty, absent,
 * or itself search-shaped (no search→search rewrite), and `applyUpgrade`'s
 * `<column> LIKE '<search-prefix>%'` guard makes a row that got verified
 * between SELECT and UPDATE a counted no-op (`skipped_not_search`).
 *
 * Dedup: an in-run URL cache keyed on normalized (artist, album, track),
 * storing the per-service verified-URL set. The track component is
 * load-bearing (LML links can be per-track). Album-phase keys use an empty
 * track and never collide with flowsheet keys.
 *
 * Resumability: id-cursor iteration per phase; `UPGRADE_ALBUM_AFTER_ID` /
 * `UPGRADE_FLOWSHEET_AFTER_ID` resume from the summary log's per-phase
 * `last_id`. Re-runs are idempotent — upgraded rows stop being search-shaped
 * and drop out of the WHERE, and the apply guard no-ops a racing fill.
 *
 * Cooperative pause, SIGTERM stop, and loadBatch retry mirror
 * `jobs/apple-music-url-backfill/orchestrate.ts`.
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
import {
  applyUpgrade,
  extractStreamingUrls,
  isSearchShaped,
  SERVICE_CONFIGS,
  type ApplyOutcome,
  type ApplyTarget,
  type UpgradeService,
} from './resolve.js';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'streaming-url-upgrade';

export const BATCH_SIZE = 100;

/**
 * Delay between the two passes. LML#706's background streaming post-process
 * typically fills the album cache within seconds of the first lookup; 15 s
 * clears it with headroom without doubling the per-candidate wall clock.
 */
export const SECOND_PASS_DELAY_MS = 15_000;

/**
 * Flowsheet is scoped by recency — the 1.34M deep tail is deferred (BS#1672).
 * The default matches the AC1 audit window; override with
 * UPGRADE_FLOWSHEET_SINCE (set an old date like '1900-01-01' for full scope).
 */
export const FLOWSHEET_SINCE_DEFAULT = '2026-05-01';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ALBUM_METADATA_TABLE = sql.raw(`"${SCHEMA}"."album_metadata"`);
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/**
 * Retry budget for the per-batch SELECT — a transient RDS failover should
 * not abort a multi-hour drain. Same shape as apple-music-url-backfill.
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

export const resolveBatchSize = (raw: string | undefined = process.env.UPGRADE_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'UPGRADE_BATCH_SIZE', BATCH_SIZE);

export const resolveSecondPassDelayMs = (raw: string | undefined = process.env.UPGRADE_SECOND_PASS_DELAY_MS): number =>
  requireNonNegativeInt(raw, 'UPGRADE_SECOND_PASS_DELAY_MS', SECOND_PASS_DELAY_MS, {
    unit: 'ms',
    note: 'Use 0 to fire the second pass immediately.',
  });

export const resolveMaxRowsPerTable = (raw: string | undefined = process.env.UPGRADE_MAX_ROWS_PER_TABLE): number =>
  requireNonNegativeInt(raw, 'UPGRADE_MAX_ROWS_PER_TABLE', 0, {
    note: 'Use 0 for unlimited; a positive cap bounds a sample/pilot run.',
  });

export const resolveAfterId = (envName: string, raw: string | undefined): number =>
  requireNonNegativeInt(raw, envName, 0, {
    note: 'Resume cursor — the summary log of the previous run carries the per-phase last_id.',
  });

/**
 * Flowsheet recency cutoff (`add_time >= <since>`). Validated as YYYY-MM-DD;
 * an unparseable value falls back to the default with a warn (the JSON logger
 * isn't up at module-load time). Not injectable through requireNonNegativeInt
 * since it's a date, not a count.
 */
export const resolveFlowsheetSince = (raw: string | undefined = process.env.UPGRADE_FLOWSHEET_SINCE): string => {
  if (raw === undefined || raw === '') return FLOWSHEET_SINCE_DEFAULT;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.warn(
      `orchestrate: UPGRADE_FLOWSHEET_SINCE=${raw} is not YYYY-MM-DD; using default ${FLOWSHEET_SINCE_DEFAULT}`
    );
    return FLOWSHEET_SINCE_DEFAULT;
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

export type LookupFn = (artist: string, album?: string, track?: string) => Promise<LookupResponse>;
export type ApplyFn = (target: ApplyTarget, id: number, service: UpgradeService, url: string) => Promise<ApplyOutcome>;

type CandidateRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title?: string | null;
  spotify_url: string | null;
  bandcamp_url: string | null;
};

/** Per-service tallies within a phase. */
export type ServiceTotals = {
  /** Rows where this column was search-shaped (i.e. a pending upgrade). */
  candidates: number;
  upgraded: number;
  would_upgrade: number;
  still_search: number;
  skipped_not_search: number;
  db_error: number;
};

export type PhaseTotals = {
  /** Rows matching the OR predicate (search-shaped on at least one column). */
  candidates: number;
  scanned: number;
  /** Row-level: the LML lookup for the row failed (no column processed). */
  lml_error: number;
  cache_hits: number;
  second_pass_attempts: number;
  second_pass_resolved: number;
  last_id: number;
  spotify: ServiceTotals;
  bandcamp: ServiceTotals;
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

/** Normalized dedup key. Track is part of the key on purpose (per-track links). */
const normalize = (s: string | null | undefined): string => (s ?? '').trim().normalize('NFKC').toLowerCase();
const cacheKey = (artist: string, album: string | null | undefined, track: string | null | undefined): string =>
  normalize(artist) + '\0' + normalize(album) + '\0' + normalize(track);

/** Service → column name, derived from SERVICE_CONFIGS (no per-service branch). */
const COLUMN_BY_SERVICE: Record<UpgradeService, 'spotify_url' | 'bandcamp_url'> = Object.fromEntries(
  SERVICE_CONFIGS.map((cfg) => [cfg.service, cfg.column])
) as Record<UpgradeService, 'spotify_url' | 'bandcamp_url'>;

/** Current value of a service's column on the candidate row. */
const rowColumnValue = (row: CandidateRow, service: UpgradeService): string | null => {
  const value = (row as Record<string, unknown>)[COLUMN_BY_SERVICE[service]];
  return typeof value === 'string' ? value : null;
};

/**
 * The search-shaped OR predicate, built by iterating SERVICE_CONFIGS so the
 * SQL LIKE clauses can never drift from the write-side guard OR silently omit
 * a newly-appended service. `alias` is the table alias (`am` / `f`).
 */
const searchShapedOr = (alias: 'am' | 'f') => {
  const [first, ...rest] = SERVICE_CONFIGS;
  let clause = sql`${sql.raw(`${alias}."${first.column}"`)} LIKE ${first.searchPrefix + '%'}`;
  for (const cfg of rest) {
    clause = sql`${clause} OR ${sql.raw(`${alias}."${cfg.column}"`)} LIKE ${cfg.searchPrefix + '%'}`;
  }
  return sql`(${clause})`;
};

/**
 * Shared WHERE fragments so the phase-start COUNT and the batch SELECT can
 * never drift apart (the count IS the "SELECT with the same predicate first"
 * the issue's data-safety constraint asks for).
 */
const albumWhere = (afterId: number) => sql`
  WHERE ${searchShapedOr('am')}
    AND COALESCE(a."artist_name", l."artist_name") IS NOT NULL
    AND am."album_id" > ${afterId}
`;

const flowsheetWhere = (afterId: number, since: string) => sql`
  WHERE f."entry_type" = 'track'
    AND ${searchShapedOr('f')}
    AND f."artist_name" IS NOT NULL
    AND f."add_time" >= ${since}
    AND f."id" > ${afterId}
`;

const albumFrom = sql`
  FROM ${ALBUM_METADATA_TABLE} am
  JOIN ${LIBRARY_TABLE} l ON l."id" = am."album_id"
  LEFT JOIN ${ARTISTS_TABLE} a ON l."artist_id" = a."id"
`;

const flowsheetFrom = sql`
  FROM ${FLOWSHEET_TABLE} f
`;

const countCandidates = async (target: ApplyTarget, afterId: number, since: string): Promise<number> => {
  const query =
    target === 'album_metadata'
      ? sql`SELECT COUNT(*)::int AS count ${albumFrom} ${albumWhere(afterId)}`
      : sql`SELECT COUNT(*)::int AS count ${flowsheetFrom} ${flowsheetWhere(afterId, since)}`;
  const rows = (await db.execute(query)) as unknown as Array<{ count: number | string }>;
  return Number(rows?.[0]?.count ?? 0);
};

const loadBatchOnce = async (
  target: ApplyTarget,
  afterId: number,
  batchSize: number,
  since: string
): Promise<CandidateRow[]> => {
  const query =
    target === 'album_metadata'
      ? sql`
          SELECT
            am."album_id" AS "id",
            COALESCE(a."artist_name", l."artist_name") AS "artist_name",
            l."album_title" AS "album_title",
            am."spotify_url" AS "spotify_url",
            am."bandcamp_url" AS "bandcamp_url"
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
            f."track_title",
            f."spotify_url",
            f."bandcamp_url"
          ${flowsheetFrom}
          ${flowsheetWhere(afterId, since)}
          ORDER BY f."id" ASC
          LIMIT ${batchSize}
        `;
  const rows = (await db.execute(query)) as unknown as CandidateRow[];
  return rows ?? [];
};

/**
 * loadBatch with transient-error retry. Honors stopRequested so shutdown
 * isn't blocked by retry backoffs; exhausting retries throws the most recent
 * error (the caller distinguishes stop from failure via the flag).
 */
const loadBatch = async (
  target: ApplyTarget,
  afterId: number,
  batchSize: number,
  since: string
): Promise<CandidateRow[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadBatchOnce(target, afterId, batchSize, since);
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

const emptyServiceTotals = (): ServiceTotals => ({
  candidates: 0,
  upgraded: 0,
  would_upgrade: 0,
  still_search: 0,
  skipped_not_search: 0,
  db_error: 0,
});

const emptyPhaseTotals = (): PhaseTotals => ({
  candidates: 0,
  scanned: 0,
  lml_error: 0,
  cache_hits: 0,
  second_pass_attempts: 0,
  second_pass_resolved: 0,
  last_id: 0,
  spotify: emptyServiceTotals(),
  bandcamp: emptyServiceTotals(),
});

type StreamingUrlSet = Record<UpgradeService, string | null>;

type PhaseDeps = {
  lookup: LookupFn;
  apply: ApplyFn;
  dryRun: boolean;
  secondPassDelayMs: number;
  urlCache: Map<string, StreamingUrlSet>;
};

/**
 * Drive a single candidate through (cached) lookup → two-pass resolution →
 * per-service guarded apply. Catches lookup AND apply errors so one bad row
 * (or one bad column) cannot abort the run. Mutates the phase totals
 * directly (row-level counters + per-service tallies); the caller owns
 * scanned/last_id.
 */
const processCandidate = async (
  target: ApplyTarget,
  row: CandidateRow,
  totals: PhaseTotals,
  deps: PhaseDeps
): Promise<void> => {
  const pending = SERVICE_CONFIGS.filter((cfg) => isSearchShaped(cfg.service, rowColumnValue(row, cfg.service)));
  if (pending.length === 0) return; // predicate guarantees ≥1, but stay defensive
  for (const cfg of pending) totals[cfg.service].candidates += 1;

  const key = cacheKey(row.artist_name, row.album_title, row.track_title);

  let urls: StreamingUrlSet;
  const cached = deps.urlCache.get(key);
  if (cached) {
    totals.cache_hits += 1;
    urls = cached;
  } else {
    const album = row.album_title ?? undefined;
    const track = row.track_title ?? undefined;
    try {
      urls = extractStreamingUrls(await deps.lookup(row.artist_name, album, track));
      // Second pass fires only when the first resolved nothing for any
      // still-pending column — LML#706's fill lands shortly after.
      if (pending.every((cfg) => urls[cfg.service] === null)) {
        totals.second_pass_attempts += 1;
        await stopAwareSleep(deps.secondPassDelayMs);
        urls = extractStreamingUrls(await deps.lookup(row.artist_name, album, track));
        if (pending.some((cfg) => urls[cfg.service] !== null)) totals.second_pass_resolved += 1;
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
      totals.lml_error += 1;
      return;
    }
    deps.urlCache.set(key, urls);
  }

  for (const cfg of pending) {
    const service = cfg.service;
    const st = totals[service];
    const verified = urls[service];
    if (verified === null) {
      st.still_search += 1;
      continue;
    }
    if (deps.dryRun) {
      st.would_upgrade += 1;
      continue;
    }
    try {
      const outcome = await deps.apply(target, row.id, service, verified);
      if (outcome === 'upgraded') st.upgraded += 1;
      else st.skipped_not_search += 1;
    } catch (error) {
      log('warn', 'db_error', `${target} ${service} UPDATE failed for id=${row.id}`, {
        target,
        service,
        row_id: row.id,
        error_message: errorMessage(error),
      });
      captureError(error, 'db_error', { target, service, row_id: row.id, url: verified });
      st.db_error += 1;
    }
  }
};

export const runUpgrade = async (opts: {
  lookup: LookupFn;
  apply?: ApplyFn;
  dryRun: boolean;
  batchSize?: number;
  maxRowsPerTable?: number;
  secondPassDelayMs?: number;
  albumAfterId?: number;
  flowsheetAfterId?: number;
  flowsheetSince?: string;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
}): Promise<RunResult> => {
  const dryRun = opts.dryRun;
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const maxRowsPerTable = opts.maxRowsPerTable ?? resolveMaxRowsPerTable();
  const secondPassDelayMs = opts.secondPassDelayMs ?? resolveSecondPassDelayMs();
  const albumAfterId =
    opts.albumAfterId ?? resolveAfterId('UPGRADE_ALBUM_AFTER_ID', process.env.UPGRADE_ALBUM_AFTER_ID);
  const flowsheetAfterId =
    opts.flowsheetAfterId ?? resolveAfterId('UPGRADE_FLOWSHEET_AFTER_ID', process.env.UPGRADE_FLOWSHEET_AFTER_ID);
  const flowsheetSince = opts.flowsheetSince ?? resolveFlowsheetSince();
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  const deps: PhaseDeps = {
    lookup: opts.lookup,
    apply: opts.apply ?? applyUpgrade,
    dryRun,
    secondPassDelayMs,
    urlCache: new Map<string, StreamingUrlSet>(),
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
    flowsheet_since: flowsheetSince,
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
  // Pre-seed the resume cursors so a run stopped before a phase starts still
  // logs the operator's own cursor back out (not a misleading 0).
  result.album_metadata.last_id = albumAfterId;
  result.flowsheet.last_id = flowsheetAfterId;
  let failure: { error: unknown } | null = null;

  const runPhase = async (target: ApplyTarget, afterId: number): Promise<void> => {
    const totals = result[target];
    totals.last_id = afterId;

    totals.candidates = await countCandidates(target, afterId, flowsheetSince);
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
        rows = await loadBatch(target, lastId, batchSize, flowsheetSince);
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
      const before = JSON.parse(JSON.stringify(totals)) as PhaseTotals;

      for (const row of rows) {
        await processCandidate(target, row, totals, deps);
        totals.scanned += 1;
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
        lml_error: totals.lml_error - before.lml_error,
        cache_hits: totals.cache_hits - before.cache_hits,
        spotify_upgraded: totals.spotify.upgraded - before.spotify.upgraded,
        spotify_would_upgrade: totals.spotify.would_upgrade - before.spotify.would_upgrade,
        spotify_still_search: totals.spotify.still_search - before.spotify.still_search,
        bandcamp_upgraded: totals.bandcamp.upgraded - before.bandcamp.upgraded,
        bandcamp_would_upgrade: totals.bandcamp.would_upgrade - before.bandcamp.would_upgrade,
        bandcamp_still_search: totals.bandcamp.still_search - before.bandcamp.still_search,
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
        name: 'streaming_url_upgrade.run.summary',
        attributes: {
          'upgrade.dry_run': dryRun,
          'upgrade.album.candidates': result.album_metadata.candidates,
          'upgrade.album.spotify_upgraded': result.album_metadata.spotify.upgraded,
          'upgrade.album.spotify_would_upgrade': result.album_metadata.spotify.would_upgrade,
          'upgrade.album.bandcamp_upgraded': result.album_metadata.bandcamp.upgraded,
          'upgrade.album.bandcamp_would_upgrade': result.album_metadata.bandcamp.would_upgrade,
          'upgrade.album.last_id': result.album_metadata.last_id,
          'upgrade.flowsheet.candidates': result.flowsheet.candidates,
          'upgrade.flowsheet.spotify_upgraded': result.flowsheet.spotify.upgraded,
          'upgrade.flowsheet.spotify_would_upgrade': result.flowsheet.spotify.would_upgrade,
          'upgrade.flowsheet.bandcamp_upgraded': result.flowsheet.bandcamp.upgraded,
          'upgrade.flowsheet.bandcamp_would_upgrade': result.flowsheet.bandcamp.would_upgrade,
          'upgrade.flowsheet.last_id': result.flowsheet.last_id,
          'upgrade.stopped': result.stopped,
          'upgrade.failed': result.failed,
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
