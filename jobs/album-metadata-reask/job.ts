/**
 * album-metadata-reask — one-shot re-ask of LML for `album_metadata` rows whose
 * stored Discogs release disagrees with the catalog card's current pin, or
 * still serves a pin that was removed (BS#3137).
 *
 * So far (BS#3144) the knobs and the dry run, which makes zero LML calls and
 * zero writes. Every other mode refuses, non-zero, until its slice lands.
 *
 * The env parsers are copied from `jobs/album-metadata-bio-fill/job.ts`
 * (decision 6: copy, extract only when a third job needs them).
 *
 * @see WXYC/Backend-Service#3137
 */

import { readFile } from 'fs/promises';
import { closeDatabaseConnection, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { BULK_LOOKUP_INPUT_CAP } from '@wxyc/lml-client';
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

/** The modes later slices build, each with the issue that builds it. */
const PENDING_MODES = new Map([
  ['--execute', '#3151'],
  ['--preview', '#3150'],
  ['--restore', '#3148'],
  ['--catalog-pass', '#3146'],
]);

/**
 * Refuse a pending mode before anything is read (and before the input files
 * are required, which `--restore` and `--catalog-pass` will not need), and any
 * other flag, so a typo cannot fall through to a run. `--dry-run` is the default.
 */
const checkFlags = (args: string[]): void => {
  for (const arg of args.slice(2)) {
    if (!arg.startsWith('--') || arg === '--dry-run') continue;
    const issue = PENDING_MODES.get(arg);
    throw new Error(
      issue
        ? `[${JOB_NAME}] ${arg} is not available yet; it lands with ${issue}. Run with no flags for the dry run.`
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
const resolveAlbumIds = (raw: string | undefined): number[] => {
  if (raw === undefined || raw.trim() === '') return [];
  const invalid = (why: string): Error =>
    new Error(`[${JOB_NAME}] Invalid ${ALBUM_IDS_ENV}=${JSON.stringify(raw)}: ${why}`);
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
}

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
  };
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
  for (const row of candidates) {
    const verdict = admit(row, grades.byLibraryId);
    if (verdict.ask) {
      admission.asked += 1;
      // A `pin_removed` row is asked at any tier but `hold_manual`; only a `pin_mismatch` row is the exception.
      if (row.reason === 'pin_mismatch' && verdict.entry.tier === 'hold_ungradeable')
        admission.ungradeable_exception += 1;
    } else {
      admission.held[verdict.hold] = (admission.held[verdict.hold] ?? 0) + 1;
    }
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
    // The summary is already on the `dry_run_plan` line.
    await runReask(resolveOptions());
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
