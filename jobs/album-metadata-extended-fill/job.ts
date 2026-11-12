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
 * cache misses. `--execute` fills the columns. See the README for the run
 * procedure.
 *
 * @see WXYC/Backend-Service#1442
 */

import { closeDatabaseConnection, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { READ_TIMEOUT_DEFAULT, cohortStats, enumerateCohort, type CohortStats } from './cohort.js';
import { FillAbortError, PIN_BATCH_SIZE, executeFill, type ExecuteSummary } from './execute.js';
import { createLmlFetcher, createPacer } from './fetch.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';
import { lookupBatchPins } from './pins.js';
import { addProbeAlbum, emptyProbeTotals, probeAlbum, summarizeProbe } from './probe.js';

const JOB_NAME = 'album-metadata-extended-fill' as const;

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
/** Discogs release ids that 404'd once, from the previous run's `next_run`. */
export const NOT_FOUND_RELEASE_IDS_ENV = 'EXTENDED_FILL_NOT_FOUND_RELEASE_IDS';
/** Discogs artist ids that 404'd once, likewise. */
export const NOT_FOUND_ARTIST_IDS_ENV = 'EXTENDED_FILL_NOT_FOUND_ARTIST_IDS';
/** Stop after this many albums in a row LML left unanswered; `0` disables it. */
export const MAX_CONSECUTIVE_UNANSWERED_ENV = 'EXTENDED_FILL_MAX_CONSECUTIVE_UNANSWERED';
/** Stop after this many release 404s in a row; `0` disables it. */
export const MAX_CONSECUTIVE_NOT_FOUND_ENV = 'EXTENDED_FILL_MAX_CONSECUTIVE_NOT_FOUND';
/** Failed writes in a row that mean the database is unreachable, not one bad row. */
export const MAX_CONSECUTIVE_WRITE_FAILURES = 10;
/** How many ids one list may hold, as in the bio fill. */
export const ALBUM_IDS_CAP = 200;

/** Unset or blank is no list; anything else is a list or an error, so a typo
 * cannot turn a retry into a whole-cohort run. Copied from the bio fill. */
const resolveIdList = (raw: string | undefined, envName: string): number[] => {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const invalid = (why: string) => new Error(`[${JOB_NAME}] Invalid ${envName}=${JSON.stringify(raw)}: ${why}`);
  const ids = raw.split(',').map((token) => {
    const text = token.trim();
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 2_147_483_647) {
      throw invalid(`${JSON.stringify(text)} is not an id; expected comma-separated positive integers.`);
    }
    return Number(text);
  });
  const distinct = [...new Set(ids)].sort((a, b) => a - b);
  if (distinct.length > ALBUM_IDS_CAP) {
    throw invalid(`at most ${ALBUM_IDS_CAP} ids per run, got ${distinct.length}.`);
  }
  return distinct;
};

export type FillMode = 'dry_run' | 'probe' | 'execute';

export interface FillOptions {
  mode: FillMode;
  ratePerMin: number;
  readTimeoutMs: number;
  maxAlbums: number;
  afterAlbumId: number;
  albumIds: number[];
  probeAlbums: number;
  notFoundReleaseIds: number[];
  notFoundArtistIds: number[];
  maxConsecutiveUnanswered: number;
  maxConsecutiveNotFound: number;
}

/** The arguments this job understands. Anything else is refused, so a mistyped flag cannot exit 0. */
const KNOWN_ARGS: readonly string[] = ['--dry-run', '--execute'];

/** Parse the env and argv. A value that does not parse is an error, never a default.
 * The dry run is the default; only `--execute` writes. */
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
  const albumIds = resolveIdList(env[ALBUM_IDS_ENV], ALBUM_IDS_ENV);
  const execute = args.includes('--execute');
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
  if (probeAlbums > 0 && probeAlbums < albumIds.length) {
    throw refuse(
      `${PROBE_ALBUMS_ENV}=${probeAlbums} is smaller than the ${albumIds.length} listed ids in ${ALBUM_IDS_ENV}.`
    );
  }
  if (probeAlbums > 0 && args.includes('--dry-run')) {
    throw refuse(`--dry-run makes no LML calls, so it cannot run with ${PROBE_ALBUMS_ENV}=${probeAlbums}.`);
  }
  if (execute && (probeAlbums > 0 || args.includes('--dry-run'))) {
    throw refuse(`--execute writes, so it cannot run with --dry-run or ${PROBE_ALBUMS_ENV}.`);
  }
  return {
    mode: execute ? 'execute' : probeAlbums > 0 ? 'probe' : 'dry_run',
    ratePerMin: requirePositiveInt(env[RATE_PER_MIN_ENV], RATE_PER_MIN_ENV, 30, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    maxAlbums,
    afterAlbumId,
    albumIds,
    probeAlbums,
    notFoundReleaseIds: resolveIdList(env[NOT_FOUND_RELEASE_IDS_ENV], NOT_FOUND_RELEASE_IDS_ENV),
    notFoundArtistIds: resolveIdList(env[NOT_FOUND_ARTIST_IDS_ENV], NOT_FOUND_ARTIST_IDS_ENV),
    maxConsecutiveUnanswered: requireNonNegativeInt(
      env[MAX_CONSECUTIVE_UNANSWERED_ENV],
      MAX_CONSECUTIVE_UNANSWERED_ENV,
      10,
      ctx
    ),
    maxConsecutiveNotFound: requireNonNegativeInt(
      env[MAX_CONSECUTIVE_NOT_FOUND_ENV],
      MAX_CONSECUTIVE_NOT_FOUND_ENV,
      10,
      ctx
    ),
  };
};

/** Cooperative stop, flipped by the first SIGTERM/SIGINT; the album in flight finishes. */
let stopRequested = false;
let stopSignals = 0;
/** The summary as it stands, for a second signal to log; set only while a run has one. */
let forcedExitReport: ((signal: NodeJS.Signals) => void) | undefined;
export const __resetStopForTesting = (): void => {
  stopRequested = false;
  stopSignals = 0;
  forcedExitReport = undefined;
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
  execute?: ExecuteSummary;
}

/** Run the dry run, the probe, or (`--execute`) the fill. Only the fill writes. */
export const runFill = async (options: FillOptions): Promise<FillSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, { ...options });
  if (options.mode === 'probe') {
    log(
      'warn',
      'probe_spends_quota',
      `PROBE, NOT A DRY RUN: ${PROBE_ALBUMS_ENV} is set, so this run fetches from LML and spends Discogs quota on every cache miss. Unset it for a dry run.`,
      { probe_albums: options.probeAlbums }
    );
  }
  const cohort = await cohortStats(options.readTimeoutMs);
  // A probe takes the first N albums, still under the run cap.
  const probeLimit = options.maxAlbums > 0 ? Math.min(options.probeAlbums, options.maxAlbums) : options.probeAlbums;
  const candidates = await enumerateCohort({
    limit: options.mode === 'probe' ? probeLimit : options.maxAlbums,
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
    log('info', 'dry_run_plan', 'DRY RUN — no LML calls, no writes. Pass --execute to write.', { ...summary });
    return summary;
  }
  const lml = createLmlFetcher(createPacer(options.ratePerMin));
  if (options.mode === 'execute') {
    return await runExecute(options, summary, candidates, lml);
  }
  const totals = emptyProbeTotals();
  try {
    for (let i = 0; i < candidates.length; i += PIN_BATCH_SIZE) {
      const batch = candidates.slice(i, i + PIN_BATCH_SIZE);
      const pins = await lookupBatchPins(batch, lml);
      for (const candidate of batch) {
        addProbeAlbum(totals, await probeAlbum(candidate, lml, pins.get(candidate.album_id)));
      }
    }
  } catch (err) {
    // The quota is already spent: keep what it bought before the error ends the run.
    const error = err instanceof Error ? err.message : String(err);
    log('error', 'probe_summary', `PROBE stopped after ${totals.albums} albums, nothing written.`, {
      ...summary,
      lml_calls: lml.calls(),
      probe: summarizeProbe(totals),
      error,
    });
    throw err;
  }
  Object.assign(summary, { lml_calls: lml.calls(), probe: summarizeProbe(totals) });
  log('info', 'probe_summary', `PROBE — ${candidates.length} albums fetched from LML, nothing written.`, {
    ...summary,
  });
  return summary;
};

const runExecute = async (
  options: FillOptions,
  summary: FillSummary,
  candidates: Awaited<ReturnType<typeof enumerateCohort>>,
  lml: ReturnType<typeof createLmlFetcher>
): Promise<FillSummary> => {
  const report = (execute: ExecuteSummary) => ({ ...summary, lml_calls: lml.calls(), execute });
  try {
    const execute = await executeFill(
      candidates,
      lml,
      {
        afterAlbumId: options.afterAlbumId,
        albumIds: options.albumIds,
        maxAlbums: options.maxAlbums,
        notFoundReleaseIds: options.notFoundReleaseIds,
        notFoundArtistIds: options.notFoundArtistIds,
        limits: {
          maxConsecutiveUnanswered: options.maxConsecutiveUnanswered,
          maxConsecutiveNotFound: options.maxConsecutiveNotFound,
          maxConsecutiveWriteFailures: MAX_CONSECUTIVE_WRITE_FAILURES,
        },
      },
      {
        shouldStop: () => stopRequested,
        onProgress: (current) => {
          // The album in flight is safe to abandon: its write is fill-null, and
          // it is above next_run's cursor or in its list.
          forcedExitReport = (signal) =>
            log('error', 'summary', `${JOB_NAME} forced to exit by a second ${signal}`, {
              ...report(current),
              forced_exit: true,
            });
        },
      }
    );
    return Object.assign(summary, report(execute));
  } catch (err) {
    if (err instanceof FillAbortError) {
      // `main`'s `finished` line will not run; this keeps the totals and `next_run`.
      log('error', 'summary', err.message, report(err.summary));
    }
    throw err;
  } finally {
    forcedExitReport = undefined;
  }
};

/**
 * SIGTERM/SIGINT, as in the bio fill. The first asks the loop to stop before
 * the next album. A second logs the summary as it stands with
 * `forced_exit: true` and exits 1. A third and later find the exit under way.
 */
export const handleStopSignal = (signal: NodeJS.Signals): void => {
  stopSignals += 1;
  if (stopSignals === 1) {
    log('warn', 'signal', `received ${signal}; requesting graceful stop`, { signal });
    stopRequested = true;
    return;
  }
  if (stopSignals > 2) {
    return;
  }
  let exitCode = 1;
  if (forcedExitReport) {
    forcedExitReport(signal);
  } else {
    log('warn', 'forced_exit', `${JOB_NAME} forced to exit by a second ${signal}`, { signal });
    exitCode = Number(process.exitCode ?? 1);
  }
  void closeLogger()
    .catch(() => undefined)
    .then(() => process.exit(exitCode));
};

/** Entry point: run, log the outcome, close the logger and the pool. */
export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  process.on('SIGTERM', handleStopSignal);
  process.on('SIGINT', handleStopSignal);
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
