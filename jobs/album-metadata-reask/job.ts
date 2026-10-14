/**
 * album-metadata-reask — one-shot re-ask of LML for `album_metadata` rows whose
 * stored Discogs release disagrees with the catalog card's current pin, or
 * still serves a pin that was removed (BS#3137).
 *
 * This slice (BS#3144) is the knobs and the dry run. The dry run is the
 * default and makes zero LML calls and zero writes: it validates the three
 * input files, counts and enumerates the cohort, admits it (decision 2), and
 * logs what a run would ask. Every other mode is refused, loudly and non-zero,
 * until the slice that builds it lands.
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

/**
 * The flags for the modes later slices build, each with the issue that builds
 * it. `--restore` and `--catalog-pass` take a run id; this slice only sees
 * that they were asked for.
 */
const PENDING_MODES = {
  '--execute': '#3151',
  '--preview': '#3150',
  '--restore': '#3148',
  '--catalog-pass': '#3146',
} as const;
export type ModeFlag = keyof typeof PENDING_MODES;

/** `album_id` is a Postgres `integer`. */
const ALBUM_ID_MAX = 2_147_483_647;

const requireFile = (env: NodeJS.ProcessEnv, name: string): string => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '')
    throw new Error(`[${JOB_NAME}] ${name} is required: the path to the file.`);
  return raw;
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
  /** The mode flags given, in a fixed order. None is the dry run. */
  modes: ModeFlag[];
}

/** Dry-run is the DEFAULT. */
export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): ReaskOptions => {
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
    sampleSeed: seed === undefined || seed.trim() === '' ? null : requireNonNegativeInt(seed, SAMPLE_SEED_ENV, 0, CTX),
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
    modes: (Object.keys(PENDING_MODES) as ModeFlag[]).filter((flag) => args.includes(flag)),
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
  /** Batches over the asked rows. */
  batches: number;
}

const fileSummary = <T>(file: InputFile<T>) => ({ sha256: file.sha256, rows: file.rows.length });

export const runReask = async (options: ReaskOptions): Promise<DryRunSummary> => {
  const [pending] = options.modes;
  if (pending) {
    throw new Error(
      `[${JOB_NAME}] ${pending} is not available yet; it lands with ${PENDING_MODES[pending]}. Run with no flags for the dry run.`
    );
  }
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
  if (options.albumIds.length > 0) {
    const enumeratedIds = new Set(candidates.map((c) => c.album_id));
    const missing = options.albumIds.filter((id) => !enumeratedIds.has(id));
    if (missing.length > 0) {
      log('warn', 'listed_ids_not_in_cohort', `${missing.length} listed albums are not in the cohort; not asked`, {
        album_ids: missing,
      });
    }
  }

  const admission: DryRunSummary['admission'] = { asked: 0, ungradeable_exception: 0, held: {} };
  for (const row of candidates) {
    const verdict = admit(row, grades.byLibraryId);
    if (verdict.ask) {
      admission.asked += 1;
      if (verdict.entry.tier === 'hold_ungradeable') admission.ungradeable_exception += 1;
    } else {
      admission.held[verdict.hold] = (admission.held[verdict.hold] ?? 0) + 1;
    }
  }

  const summary: DryRunSummary = {
    inputs,
    cohort: counts,
    enumerated: candidates.length,
    admission,
    batches: Math.ceil(admission.asked / options.batchSize),
  };
  log(
    'info',
    'dry_run_plan',
    `DRY RUN — no LML calls, no writes. Would ask ${admission.asked} albums in ${summary.batches} batches of up to ${options.batchSize}.`,
    { ...summary, estimated_minutes: Math.ceil(summary.batches / options.ratePerMin) }
  );
  return summary;
};

export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const summary = await runReask(resolveOptions());
    log('info', 'finished', `${JOB_NAME} done`, { ...summary });
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

// Guard the auto-invoke so jest's module load doesn't fire a stray run (same
// rationale as `album-metadata-bio-fill#main`).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
