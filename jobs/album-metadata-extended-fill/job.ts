/**
 * album-metadata-extended-fill (BS#1442): fill the eight extended
 * `album_metadata` columns on rows written before BS#1336, reading each from
 * the release the row's `discogs_url` already names (`getRelease`,
 * `getArtistDetails`) rather than searching again, which lands on a different
 * release for about 40% of cards.
 *
 * The dry run (the default, or `--dry-run`) reads the cohort and makes no LML
 * call. `EXTENDED_FILL_PROBE_ALBUMS=N` fetches the first N albums from LML and
 * logs what a write would add; it writes nothing but spends Discogs quota on
 * cache misses.
 *
 * @see WXYC/Backend-Service#1442
 */

import { closeDatabaseConnection, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { READ_TIMEOUT_DEFAULT, cohortStats, enumerateCohort, type CohortStats } from './cohort.js';
import { createLmlFetcher, createPacer } from './fetch.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';
import { lookupBatchPins } from './pins.js';
import { addProbeAlbum, emptyProbeTotals, probeAlbum, summarizeProbe } from './probe.js';

const JOB_NAME = 'album-metadata-extended-fill' as const;

/** Albums per pins call; one call covers a batch, before any of its release fetches. */
export const PIN_BATCH_SIZE = 100;

/** LML calls per minute, release and artist together; a cache miss reaches the Discogs API DJs share. */
export const RATE_PER_MIN_ENV = 'EXTENDED_FILL_RATE_PER_MIN';
export const READ_TIMEOUT_ENV = 'EXTENDED_FILL_READ_TIMEOUT_MS';
/** Albums per run; `0` is no cap. */
export const MAX_ALBUMS_ENV = 'EXTENDED_FILL_MAX_ALBUMS';
/** Resume cursor: only albums above this id, plus any listed. */
export const ALBUM_AFTER_ID_ENV = 'EXTENDED_FILL_ALBUM_AFTER_ID';
/** Comma-separated album ids: a retry with no cursor, or carried into a cursor run. */
export const ALBUM_IDS_ENV = 'EXTENDED_FILL_ALBUM_IDS';
/** Albums the probe fetches; `0`, the default, is no probe. */
export const PROBE_ALBUMS_ENV = 'EXTENDED_FILL_PROBE_ALBUMS';
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

export type FillMode = 'dry_run' | 'probe';

export interface FillOptions {
  mode: FillMode;
  ratePerMin: number;
  readTimeoutMs: number;
  maxAlbums: number;
  afterAlbumId: number;
  albumIds: number[];
  probeAlbums: number;
}

/** The arguments this build understands. Anything else is refused, so a
 * mistyped flag, or `--execute` before the write lands, cannot exit 0. */
const KNOWN_ARGS: readonly string[] = ['--dry-run'];

/** Parse the env and argv. A value that does not parse is an error, never a default. */
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
  const probeAlbums = requireNonNegativeInt(env[PROBE_ALBUMS_ENV], PROBE_ALBUMS_ENV, 0, ctx);
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
  if (probeAlbums > 0 && args.includes('--dry-run')) {
    throw refuse(`--dry-run makes no LML calls, so it cannot run with ${PROBE_ALBUMS_ENV}=${probeAlbums}.`);
  }
  return {
    mode: probeAlbums > 0 ? 'probe' : 'dry_run',
    ratePerMin: requirePositiveInt(env[RATE_PER_MIN_ENV], RATE_PER_MIN_ENV, 30, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    maxAlbums,
    afterAlbumId,
    albumIds,
    probeAlbums,
  };
};

export interface FillSummary {
  mode: FillMode;
  /** Cohort size and per-column gaps, ignoring the cap and cursor. */
  cohort: CohortStats;
  enumerated: number;
  first_album_id: number | null;
  last_album_id: number | null;
  lml_calls: number;
  probe?: ReturnType<typeof summarizeProbe>;
}

/** Run the dry run or the probe. Neither writes. */
export const runFill = async (options: FillOptions): Promise<FillSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, { ...options });
  const cohort = await cohortStats(options.readTimeoutMs);
  const candidates = await enumerateCohort({
    limit: options.mode === 'probe' ? options.probeAlbums : options.maxAlbums,
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
    lml_calls: 0,
  };
  if (options.mode === 'dry_run') {
    log('info', 'dry_run_plan', 'DRY RUN — no LML calls, no writes.', { ...summary });
    return summary;
  }
  const lml = createLmlFetcher(createPacer(options.ratePerMin));
  const totals = emptyProbeTotals();
  for (let i = 0; i < candidates.length; i += PIN_BATCH_SIZE) {
    const batch = candidates.slice(i, i + PIN_BATCH_SIZE);
    const pins = await lookupBatchPins(batch, lml);
    for (const candidate of batch) {
      addProbeAlbum(totals, await probeAlbum(candidate, lml, pins.get(candidate.album_id)));
    }
  }
  Object.assign(summary, { lml_calls: lml.calls(), probe: summarizeProbe(totals) });
  log('info', 'probe_summary', `PROBE — ${candidates.length} albums fetched from LML, nothing written.`, {
    ...summary,
  });
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
