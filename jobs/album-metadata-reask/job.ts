/**
 * album-metadata-reask — one-shot re-ask of LML for `album_metadata` rows whose
 * stored Discogs release disagrees with the catalog card's current pin, or
 * still serves a pin that was removed (BS#3137).
 *
 * So far the knobs and the dry run (BS#3144), which makes zero LML calls and
 * zero writes, `--catalog-pass <run_id>` (BS#3146) and `--restore <run_id>`
 * (BS#3148). Every other mode refuses, non-zero, until its slice lands.
 *
 * The env parsers are copied from `jobs/album-metadata-bio-fill/job.ts`
 * (decision 6: copy, extract only when a third job needs them).
 *
 * @see WXYC/Backend-Service#3137
 */

import { readFile } from 'fs/promises';
import { closeDatabaseConnection, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { BULK_LOOKUP_INPUT_CAP } from '@wxyc/lml-client';
import { CATALOG_STATEMENT_TIMEOUT_DEFAULT, runCatalogPass, type CatalogPassResult } from './catalog-pass.js';
import { RESTORE_STATEMENT_TIMEOUT_DEFAULT, runRestore, type RestoreOptions, type RestoreResult } from './restore.js';
import { READ_TIMEOUT_DEFAULT, countCohort, enumerateCohort, type CohortCounts, type CohortInputs } from './cohort.js';
import {
  admit,
  parseGradingManifest,
  parsePinFile,
  parseRemovalFile,
  type HoldReason,
  type InputFile,
} from './inputs.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-metadata-reask' as const;
const CTX = { context: JOB_NAME };

// -- Knobs -------------------------------------------------------------------

/** The three input files (plan, "Where the pin comes from"). No default: a guessed path is another pin state. */
export const PIN_FILE_ENV = 'REASK_PIN_FILE';
export const REMOVED_FILE_ENV = 'REASK_REMOVED_FILE';
export const GRADES_FILE_ENV = 'REASK_GRADES_FILE';

/** Items per LML bulk request; LML hard-caps at `BULK_LOOKUP_INPUT_CAP`. */
export const BATCH_SIZE_ENV = 'REASK_BULK_BATCH_SIZE';
/** Batches per minute. 4 is the plan's pacing on the prod bulk lane. */
export const RATE_PER_MIN_ENV = 'REASK_BULK_RATE_PER_MIN';
export const READ_TIMEOUT_ENV = 'REASK_READ_TIMEOUT_MS';
/** `SET LOCAL statement_timeout` for the catalog cover pass's probe and write. */
export const CATALOG_STATEMENT_TIMEOUT_ENV = 'REASK_CATALOG_STATEMENT_TIMEOUT_MS';
/** `SET LOCAL statement_timeout` for the restore's probe and writes. */
export const RESTORE_STATEMENT_TIMEOUT_ENV = 'REASK_RESTORE_STATEMENT_TIMEOUT_MS';
/** `1` admits albums a restore put back, which are otherwise held as `hold_restored`. */
export const INCLUDE_RESTORED_ENV = 'REASK_INCLUDE_RESTORED';
/** Stop after this many albums; `0` is no cap. */
export const MAX_ALBUMS_ENV = 'REASK_MAX_ALBUMS';
/** Resume cursor: only albums with `album_id` above this are enumerated. */
export const ALBUM_AFTER_ID_ENV = 'REASK_ALBUM_AFTER_ID';
/** Carried album ids; with no cursor, a retry of just those. */
export const ALBUM_IDS_ENV = 'REASK_ALBUM_IDS';
/** How many ids one list may hold: what one summary's `next_run` lists. */
export const ALBUM_IDS_CAP = 200;
/** The `--preview` sample's seed; unset is no seed. */
export const SAMPLE_SEED_ENV = 'REASK_SAMPLE_SEED';
export const MAX_CONSECUTIVE_FAILED_BATCHES_ENV = 'REASK_MAX_CONSECUTIVE_FAILED_BATCHES';
/** Batches with a `pin_not_bound` and no `rebind`; `0` disables (a residue pass). */
export const MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES_ENV = 'REASK_MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES';
/** Cooperative-pause lookback, shared with every sibling drain (BS#2147). The run sets 0. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';

/**
 * Every mode flag. A pending one names the issue that builds it. A run_id
 * mode takes the run_id that follows it and only the flags it lists, and no
 * input file: it reads only that run's backup rows (`resolveMode`).
 */
type ModeFlag = { pending: string } | { runIdOf: string; accepts: readonly string[] };
const MODE_FLAGS: ReadonlyMap<string, ModeFlag> = new Map<string, ModeFlag>([
  ['--execute', { pending: '#3151' }],
  ['--preview', { pending: '#3150' }],
  ['--catalog-pass', { runIdOf: 'the run whose covers it rewrites', accepts: [] }],
  ['--restore', { runIdOf: 'the run it restores', accepts: ['--execute', '--album-ids'] }],
]);

/**
 * The dry run's flags: refuse a pending mode before anything is read, and any
 * other flag, so a typo cannot fall through to a run. `--dry-run` is the
 * default. A run_id mode is not a dry-run flag: `resolveMode` takes it first.
 */
const checkFlags = (args: string[]): void => {
  for (const arg of args.slice(2)) {
    if (!arg.startsWith('--') || arg === '--dry-run') {
      continue;
    }
    const flag = MODE_FLAGS.get(arg);
    throw new Error(
      flag && 'pending' in flag
        ? `[${JOB_NAME}] ${arg} is not available yet; it lands with ${flag.pending}. Run with no flags for the dry run.`
        : `[${JOB_NAME}] Unknown flag ${arg}.`
    );
  }
};

/** `album_id` is a Postgres `integer`. */
const ALBUM_ID_MAX = 2_147_483_647;

const isBlank = (raw: string | undefined): boolean => !raw?.trim();

const requireFile = (env: NodeJS.ProcessEnv, name: string): string => {
  const raw = env[name];
  if (isBlank(raw)) throw new Error(`[${JOB_NAME}] ${name} is required: the path to the file.`);
  return raw as string;
};

const resolveBatchSize = (raw: string | undefined): number => {
  const batchSize = requirePositiveInt(raw, BATCH_SIZE_ENV, 5, CTX);
  if (batchSize > BULK_LOOKUP_INPUT_CAP) {
    throw new Error(
      `[${JOB_NAME}] Invalid ${BATCH_SIZE_ENV}=${JSON.stringify(raw)}: must be at most ${BULK_LOOKUP_INPUT_CAP}, LML's per-request bulk cap.`
    );
  }
  return batchSize;
};

/** Unset or blank is no list. Anything else is a list or an error: a typo read as "no list" would ask the whole cohort. */
const resolveAlbumIds = (raw: string | undefined, name: string = ALBUM_IDS_ENV): number[] => {
  if (raw === undefined || raw.trim() === '') return [];
  const invalid = (why: string): Error => new Error(`[${JOB_NAME}] Invalid ${name}=${JSON.stringify(raw)}: ${why}`);
  const ids = raw.split(',').map((token) => {
    const text = token.trim();
    const id = Number(text);
    if (!/^\d+$/.test(text) || id < 1 || id > ALBUM_ID_MAX) {
      throw invalid(`${JSON.stringify(text)} is not an album id; expected comma-separated positive integers.`);
    }
    return id;
  });
  const distinct = [...new Set(ids)].sort((a, b) => a - b);
  if (distinct.length > ALBUM_IDS_CAP) throw invalid(`at most ${ALBUM_IDS_CAP} ids per run, got ${distinct.length}.`);
  return distinct;
};

export interface ReaskOptions {
  pinFile: string;
  removedFile: string;
  gradesFile: string;
  batchSize: number;
  ratePerMin: number;
  readTimeoutMs: number;
  maxAlbums: number;
  afterAlbumId: number;
  albumIds: number[];
  sampleSeed: number | null;
  maxConsecutiveFailedBatches: number;
  maxConsecutivePinNotBoundBatches: number;
  liveActivityLookbackSeconds: number;
  /** Admit albums a restore put back (`REASK_INCLUDE_RESTORED=1`). */
  includeRestored: boolean;
}

/** Only `1` lifts the hold and only unset, blank or `0` keeps it: anything else is a typo, refused. */
const resolveIncludeRestored = (raw: string | undefined): boolean => {
  const value = raw?.trim() ?? '';
  if (value !== '' && value !== '0' && value !== '1') {
    throw new Error(`[${JOB_NAME}] Invalid ${INCLUDE_RESTORED_ENV}=${JSON.stringify(raw)}: expected 1 or 0.`);
  }
  return value === '1';
};

/** Dry-run is the DEFAULT, and for now the only mode. */
export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): ReaskOptions => {
  checkFlags(args);
  const afterAlbumId = requireNonNegativeInt(env[ALBUM_AFTER_ID_ENV], ALBUM_AFTER_ID_ENV, 0, CTX);
  const maxAlbums = requireNonNegativeInt(env[MAX_ALBUMS_ENV], MAX_ALBUMS_ENV, 0, CTX);
  const albumIds = resolveAlbumIds(env[ALBUM_IDS_ENV]);
  // A listed id above the cursor would be asked by the cursor run anyway, so it
  // means the wrong cursor was copied. The listed ids sort first, so a cap
  // drops some of them only when it is smaller than the list.
  const aboveCursor = afterAlbumId > 0 ? albumIds.find((id) => id > afterAlbumId) : undefined;
  if (aboveCursor !== undefined) {
    throw new Error(
      `[${JOB_NAME}] ${ALBUM_IDS_ENV}: ${aboveCursor} is above ${ALBUM_AFTER_ID_ENV}=${afterAlbumId}; a list carried into a cursor run must be at or below the cursor.`
    );
  }
  if (maxAlbums > 0 && maxAlbums < albumIds.length) {
    throw new Error(
      `[${JOB_NAME}] ${MAX_ALBUMS_ENV}=${maxAlbums} is smaller than the ${albumIds.length} listed ids in ${ALBUM_IDS_ENV}; it would drop some of them unreported.`
    );
  }
  const seed = env[SAMPLE_SEED_ENV];
  return {
    pinFile: requireFile(env, PIN_FILE_ENV),
    removedFile: requireFile(env, REMOVED_FILE_ENV),
    gradesFile: requireFile(env, GRADES_FILE_ENV),
    batchSize: resolveBatchSize(env[BATCH_SIZE_ENV]),
    ratePerMin: requirePositiveInt(env[RATE_PER_MIN_ENV], RATE_PER_MIN_ENV, 4, CTX),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, CTX),
    maxAlbums,
    afterAlbumId,
    albumIds,
    sampleSeed: isBlank(seed) ? null : requireNonNegativeInt(seed, SAMPLE_SEED_ENV, 0, CTX),
    maxConsecutiveFailedBatches: requirePositiveInt(
      env[MAX_CONSECUTIVE_FAILED_BATCHES_ENV],
      MAX_CONSECUTIVE_FAILED_BATCHES_ENV,
      3,
      CTX
    ),
    maxConsecutivePinNotBoundBatches: requireNonNegativeInt(
      env[MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES_ENV],
      MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES_ENV,
      3,
      { ...CTX, note: 'Use 0 to disable.' }
    ),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      300,
      CTX
    ),
    includeRestored: resolveIncludeRestored(env[INCLUDE_RESTORED_ENV]),
  };
};

export interface CatalogPassOptions {
  runId: string;
  statementTimeoutMs: number;
}

export type ReaskMode =
  | { mode: 'dry-run'; options: ReaskOptions }
  | { mode: 'catalog-pass'; options: CatalogPassOptions }
  | { mode: 'restore'; options: RestoreOptions };

const isFlag = (arg: string | undefined): boolean => isBlank(arg) || (arg as string).startsWith('--');

/**
 * The mode argv asks for. The first run_id mode in argv (`MODE_FLAGS`) takes
 * the run_id after it and only the flags it accepts; `--album-ids` takes a
 * value. With none, it is the dry run's (`resolveOptions`).
 */
export const resolveMode = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): ReaskMode => {
  const flags = args.slice(2);
  const at = flags.findIndex((arg) => 'runIdOf' in (MODE_FLAGS.get(arg) ?? {}));
  if (at === -1) {
    return { mode: 'dry-run', options: resolveOptions(env, args) };
  }
  const name = flags[at];
  const { runIdOf, accepts } = MODE_FLAGS.get(name) as Extract<ModeFlag, { runIdOf: string }>;
  if (isFlag(flags[at + 1])) {
    throw new Error(`[${JOB_NAME}] ${name} needs the run_id of ${runIdOf}.`);
  }
  const runId = flags[at + 1].trim();
  const rest = flags.filter((_, i) => i !== at && i !== at + 1);
  const idsAt = accepts.includes('--album-ids') ? rest.indexOf('--album-ids') : -1;
  if (idsAt !== -1 && isFlag(rest[idsAt + 1])) {
    throw new Error(`[${JOB_NAME}] --album-ids needs a value: comma-separated album ids.`);
  }
  const extra = rest.filter((arg, i) => !accepts.includes(arg) && (idsAt === -1 || i !== idsAt + 1));
  if (extra.length > 0) {
    throw new Error(
      `[${JOB_NAME}] ${name} takes only ${['a run_id', ...accepts].join(', ')}; also got ${extra.join(' ')}.`
    );
  }
  const timeout = (envName: string, fallback: number) => requirePositiveInt(env[envName], envName, fallback, CTX);
  if (name === '--restore' && !isBlank(env[ALBUM_IDS_ENV])) {
    throw new Error(`[${JOB_NAME}] ${ALBUM_IDS_ENV} does not narrow --restore; pass --album-ids instead.`);
  }
  if (name === '--catalog-pass') {
    const statementTimeoutMs = timeout(CATALOG_STATEMENT_TIMEOUT_ENV, CATALOG_STATEMENT_TIMEOUT_DEFAULT);
    return { mode: 'catalog-pass', options: { runId, statementTimeoutMs } };
  }
  return {
    mode: 'restore',
    options: {
      runId,
      albumIds: idsAt === -1 ? [] : resolveAlbumIds(rest[idsAt + 1], '--album-ids'),
      execute: rest.includes('--execute'),
      statementTimeoutMs: timeout(RESTORE_STATEMENT_TIMEOUT_ENV, RESTORE_STATEMENT_TIMEOUT_DEFAULT),
    },
  };
};

/**
 * `--catalog-pass <run_id>`: the pass alone, for a run that died before its end. Idempotent. A run_id with no
 * album writes is an error, so a mistyped id cannot pass for a recovery that found nothing to do.
 */
export const runCatalogPassMode = async ({
  runId,
  statementTimeoutMs,
}: CatalogPassOptions): Promise<CatalogPassResult> => {
  log('info', 'catalog_pass_started', `${JOB_NAME} catalog cover pass for run ${runId} starting`, {
    reask_run_id: runId,
  });
  const result = await runCatalogPass(runId, statementTimeoutMs);
  if (result.album_writes === 0) {
    throw new Error(`[${JOB_NAME}] Run ${runId} has no album writes; check the run_id.`);
  }
  log(
    'info',
    'catalog_pass',
    `Catalog cover pass for run ${runId}: rewrote ${result.rewritten} of ${result.probed} covers found.`,
    {
      reask_run_id: runId,
      ...result,
    }
  );
  if (result.analyze_error !== null) {
    log('warn', 'analyze_pending', `ANALYZE failed after the pass wrote; run it by hand: ${result.analyze_error}`, {
      tables: ['library'],
    });
  }
  return result;
};

/**
 * `--restore <run_id>`: count per target (dry run) or, with `--execute`, restore the run's writes nothing has
 * touched since. A run_id with no album writes in scope is an error, so a mistyped id cannot pass for a restore that
 * found nothing to do.
 */
export const runRestoreMode = async (options: RestoreOptions): Promise<RestoreResult> => {
  const { runId, execute } = options;
  const result = await runRestore(options);
  if (result.album_metadata.backed_up === 0) {
    throw new Error(`[${JOB_NAME}] Run ${runId} has no album writes in scope; check the run_id and --album-ids.`);
  }
  const { album_metadata: albums, library } = result;
  const message = execute
    ? `Restore of run ${runId}: restored ${albums.restored} albums and ${library.restored} catalog covers.`
    : `DRY RUN — no writes. Would restore ${albums.restorable} of ${albums.backed_up} albums and ${library.restorable} of ${library.backed_up} catalog covers.`;
  log('info', execute ? 'restore' : 'restore_plan', message, { reask_run_id: runId, ...result });
  if (result.analyze_error !== null) {
    log('warn', 'analyze_pending', `ANALYZE failed after the restore wrote; run it by hand: ${result.analyze_error}`);
  }
  return result;
};

// -- Dry run -----------------------------------------------------------------

export interface DryRunSummary {
  inputs: Record<'pins' | 'removed' | 'grades', { sha256: string; rows: number }>;
  cohort: CohortCounts;
  enumerated: number;
  admission: {
    asked: number;
    /** Asked `hold_ungradeable` rows: the `alex-l-2026` exception (decision 2). */
    ungradeable_exception: number;
    held: Partial<Record<HoldReason, number>>;
  };
  /** Batches over the asked rows, and the minutes they take at the configured rate. */
  batches: number;
  estimated_minutes: number;
}

const fileSummary = <T>(file: InputFile<T>) => ({ sha256: file.sha256, rows: file.rows.length });

export const runReask = async (options: ReaskOptions): Promise<DryRunSummary> => {
  log('info', 'started', `${JOB_NAME} dry run starting`, {
    batch_size: options.batchSize,
    max_albums: options.maxAlbums,
    after_album_id: options.afterAlbumId,
    album_ids: options.albumIds,
  });

  // All three parse before any read, so a malformed file costs no cohort query.
  const pins = parsePinFile(await readFile(options.pinFile));
  const removed = parseRemovalFile(await readFile(options.removedFile));
  const grades = parseGradingManifest(await readFile(options.gradesFile));
  const inputs = { pins: fileSummary(pins), removed: fileSummary(removed), grades: fileSummary(grades) };
  log('info', 'inputs', 'input files validated', inputs);

  const cohortInputs: CohortInputs = { pins: pins.rows, removed: removed.rows };
  const counts = await countCohort(cohortInputs, options.readTimeoutMs);
  const candidates = await enumerateCohort(cohortInputs, {
    limit: options.maxAlbums,
    afterAlbumId: options.afterAlbumId,
    albumIds: options.albumIds,
    timeoutMs: options.readTimeoutMs,
  });
  const missing = options.albumIds.filter((id) => !candidates.some((c) => c.album_id === id));
  if (missing.length > 0) {
    log('warn', 'listed_ids_not_in_cohort', `${missing.length} listed albums are not in the cohort; not asked`, {
      album_ids: missing,
    });
  }

  const admission: DryRunSummary['admission'] = { asked: 0, ungradeable_exception: 0, held: {} };
  const heldRestored: number[] = [];
  for (const row of candidates) {
    const verdict = admit(row, grades.byLibraryId, options.includeRestored);
    if (verdict.ask) {
      admission.asked += 1;
      // A `pin_removed` row is asked at any tier but `hold_manual`; only a `pin_mismatch` row is the exception.
      if (row.reason === 'pin_mismatch' && verdict.entry.tier === 'hold_ungradeable')
        admission.ungradeable_exception += 1;
    } else {
      admission.held[verdict.hold] = (admission.held[verdict.hold] ?? 0) + 1;
      if (verdict.hold === 'hold_restored') {
        heldRestored.push(row.album_id);
      }
    }
  }
  if (heldRestored.length > 0) {
    const message = `${heldRestored.length} restored albums held; ${INCLUDE_RESTORED_ENV}=1 asks them`;
    log('info', 'held_restored', message, { album_ids: heldRestored });
  }

  const batches = Math.ceil(admission.asked / options.batchSize);
  const summary: DryRunSummary = {
    inputs,
    cohort: counts,
    enumerated: candidates.length,
    admission,
    batches,
    estimated_minutes: Math.ceil(batches / options.ratePerMin),
  };
  log(
    'info',
    'dry_run_plan',
    `DRY RUN — no LML calls, no writes. Would ask ${admission.asked} albums in ${batches} batches of up to ${options.batchSize}.`,
    { ...summary }
  );
  return summary;
};

export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    // The summary is already on the `dry_run_plan`, `catalog_pass`, `restore_plan` or `restore` line.
    const mode = resolveMode();
    if (mode.mode === 'catalog-pass') {
      await runCatalogPassMode(mode.options);
    } else if (mode.mode === 'restore') {
      await runRestoreMode(mode.options);
    } else {
      await runReask(mode.options);
    }
    log('info', 'finished', `${JOB_NAME} done`);
    process.exitCode = 0;
  } catch (err) {
    captureError(err, 'main');
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'failed', `${JOB_NAME} failed: ${message}`, { error_message: message });
    process.exitCode = 1;
  } finally {
    await closeLogger();
    await closeDatabaseConnection();
  }
};

// No auto-run under jest.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
