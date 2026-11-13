/**
 * album-metadata-extended-fill (BS#1442): fill the eight extended
 * `album_metadata` columns on rows written before BS#1336, reading each from
 * the release the row's `discogs_url` already names (`getRelease`,
 * `getArtistDetails`) rather than searching again, which lands on a different
 * release for about 40% of cards.
 *
 * The dry run (the default, or `--dry-run`) reads the cohort and makes no LML
 * call. The LML fetch, the probe and the write land in later slices of BS#1442.
 *
 * @see WXYC/Backend-Service#1442
 */

import { closeDatabaseConnection, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { READ_TIMEOUT_DEFAULT, cohortStats, enumerateCohort, type CohortStats } from './cohort.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-metadata-extended-fill' as const;

export const READ_TIMEOUT_ENV = 'EXTENDED_FILL_READ_TIMEOUT_MS';
/** Albums per run; `0` is no cap. */
export const MAX_ALBUMS_ENV = 'EXTENDED_FILL_MAX_ALBUMS';
/** Resume cursor: only albums above this id, plus any listed. */
export const ALBUM_AFTER_ID_ENV = 'EXTENDED_FILL_ALBUM_AFTER_ID';
/** Comma-separated album ids: a retry with no cursor, or carried into a cursor run. */
export const ALBUM_IDS_ENV = 'EXTENDED_FILL_ALBUM_IDS';
/** How many ids one list may hold, as in the bio fill. */
export const ALBUM_IDS_CAP = 200;

/** Unset or blank is no list; anything else is a list or an error, so a typo
 * cannot turn a retry into a whole-cohort run. Copied from the bio fill. */
const resolveAlbumIds = (raw: string | undefined): number[] => {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const invalid = (why: string) => new Error(`[${JOB_NAME}] Invalid ${ALBUM_IDS_ENV}=${JSON.stringify(raw)}: ${why}`);
  const ids = raw.split(',').map((token) => {
    const text = token.trim();
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 2_147_483_647) {
      throw invalid(`${JSON.stringify(text)} is not an album id; expected comma-separated positive integers.`);
    }
    return Number(text);
  });
  const distinct = [...new Set(ids)].sort((a, b) => a - b);
  if (distinct.length > ALBUM_IDS_CAP) {
    throw invalid(`at most ${ALBUM_IDS_CAP} ids per run, got ${distinct.length}.`);
  }
  return distinct;
};

export type FillMode = 'dry_run';

export interface FillOptions {
  mode: FillMode;
  readTimeoutMs: number;
  maxAlbums: number;
  afterAlbumId: number;
  albumIds: number[];
}

/** The arguments this build understands. Anything else is refused, so a
 * mistyped flag, or `--execute` before the write lands, cannot exit 0. */
const KNOWN_ARGS: readonly string[] = ['--dry-run'];

/** Parse the env and argv. A value that does not parse is an error, never a default. Every
 * run is a dry run until the write lands, so `--dry-run` changes nothing yet. */
export const resolveOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2)
): FillOptions => {
  const unknown = args.find((arg) => !KNOWN_ARGS.includes(arg));
  if (unknown !== undefined) {
    throw new Error(`[${JOB_NAME}] Unknown argument ${unknown}; this build accepts only ${KNOWN_ARGS.join(', ')}.`);
  }
  const ctx = { context: JOB_NAME };
  const afterAlbumId = requireNonNegativeInt(env[ALBUM_AFTER_ID_ENV], ALBUM_AFTER_ID_ENV, 0, ctx);
  const maxAlbums = requireNonNegativeInt(env[MAX_ALBUMS_ENV], MAX_ALBUMS_ENV, 2400, ctx);
  const albumIds = resolveAlbumIds(env[ALBUM_IDS_ENV]);
  const refuse = (why: string) => new Error(`[${JOB_NAME}] ${why}`);
  const aboveCursor = afterAlbumId > 0 ? albumIds.find((id) => id > afterAlbumId) : undefined;
  if (aboveCursor !== undefined) {
    throw refuse(
      `${ALBUM_IDS_ENV}: ${aboveCursor} is above ${ALBUM_AFTER_ID_ENV}=${afterAlbumId}; a carried list must be at or below the cursor.`
    );
  }
  if (maxAlbums > 0 && maxAlbums < albumIds.length) {
    throw refuse(
      `${MAX_ALBUMS_ENV}=${maxAlbums} is smaller than the ${albumIds.length} listed ids in ${ALBUM_IDS_ENV}.`
    );
  }
  return {
    mode: 'dry_run',
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    maxAlbums,
    afterAlbumId,
    albumIds,
  };
};

export interface FillSummary {
  mode: FillMode;
  /** Cohort size and per-column gaps, ignoring the cap and cursor. */
  cohort: CohortStats;
  enumerated: number;
  first_album_id: number | null;
  last_album_id: number | null;
}

/** Run the dry run: counts and the enumeration, no LML call, no write. */
export const runFill = async (options: FillOptions): Promise<FillSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, { ...options });
  const cohort = await cohortStats(options.readTimeoutMs);
  const candidates = await enumerateCohort({
    limit: options.maxAlbums,
    afterAlbumId: options.afterAlbumId,
    albumIds: options.albumIds,
    timeoutMs: options.readTimeoutMs,
  });
  const summary: FillSummary = {
    mode: options.mode,
    cohort,
    enumerated: candidates.length,
    first_album_id: candidates[0]?.album_id ?? null,
    last_album_id: candidates.at(-1)?.album_id ?? null,
  };
  log('info', 'dry_run_plan', 'DRY RUN — no LML calls, no writes.', { ...summary });
  return summary;
};

/** Entry point: run, log the outcome, close the logger and the pool. */
export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    log('info', 'finished', `${JOB_NAME} done`, { ...(await runFill(resolveOptions())) });
    process.exitCode = 0;
  } catch (err) {
    captureError(err, 'main');
    log('error', 'failed', `${JOB_NAME} failed: ${err instanceof Error ? err.message : String(err)}`, {});
    process.exitCode = 1;
  } finally {
    await closeLogger();
    await closeDatabaseConnection();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
