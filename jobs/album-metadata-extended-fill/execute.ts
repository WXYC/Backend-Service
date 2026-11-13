/**
 * The `--execute` loop (BS#1442): every enumerated album through `fillAlbum`,
 * one pins call per batch first, the per-album stop streaks, and a summary
 * that carries `next_run` however the run ends. The fetcher's pacer spaces the
 * LML calls; there is no live-activity pause, since DJs are on air around the
 * clock.
 */

import type { FillCandidate } from './cohort.js';
import type { LmlFetcher } from './fetch.js';
import { fillAlbum, type AlbumResult, type ArtistOutcome, type FillOutcome } from './fill.js';
import { log } from './logger.js';
import { EXTENDED_COLUMNS, COLUMN_MAX_LENGTH, type ExtendedColumn, type TooLongColumn } from './map.js';
import { lookupBatchPins } from './pins.js';
import {
  CARRIED_IDS_CAP,
  NO_STREAKS,
  advanceStreaks,
  planNotFound,
  planResume,
  type NextRun,
  type StreakLimits,
  type StreakTrip,
} from './resume.js';
import { analyzeAlbumMetadata } from './write.js';

/** Albums per pins call; one call covers a batch, before any of its release fetches. */
export const PIN_BATCH_SIZE = 100;

export interface ExecuteOptions {
  afterAlbumId: number;
  albumIds: number[];
  maxAlbums: number;
  notFoundReleaseIds: number[];
  notFoundArtistIds: number[];
  limits: StreakLimits;
}

const zeros = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
// prettier-ignore
const OUTCOMES: FillOutcome[] = ['filled', 'nothing_new', 'release_changed', 'write_failed', 'release_not_found_suspected', 'release_not_found', 'release_unanswered', 'pin_disagrees', 'pin_unanswered', 'no_release_id'];
/** Outcomes where LML gave no answer about the release. */
const NO_RELEASE_ANSWER: ReadonlySet<FillOutcome> = new Set([
  'pin_disagrees',
  'pin_unanswered',
  'no_release_id',
  'release_unanswered',
]);
const ARTIST: ArtistOutcome[] = ['answered', 'not_asked', 'unanswered', 'not_found_suspected', 'not_found'];

const emptyExecuteSummary = (retryOnly: boolean, afterAlbumId: number) => ({
  processed: 0,
  outcomes: zeros(OUTCOMES),
  artist: zeros(ARTIST),
  filled_by_column: zeros<ExtendedColumn>(EXTENDED_COLUMNS),
  too_long: zeros(Object.keys(COLUMN_MAX_LENGTH) as TooLongColumn[]),
  last_album_id: null as number | null,
  /** A cursor safe on its own, below every album left unsettled; null on a retry run. */
  resume_after_album_id: retryOnly ? null : afterAlbumId,
  /** Up to 200 of the albums left for the next run below `next_run`'s cursor. */
  carried_album_ids: [] as number[],
  /** What to run next; null when a retry run left nothing. */
  next_run: null as NextRun | null,
  /** The loop ended before its last album: a signal, or an abort. */
  stopped_early: false,
  /** Every album the cursor and list covered was asked, and the cap did not cut the enumeration. */
  reached_end: false,
  abort: null as StreakTrip | null,
  /** The error that ended the run, when one did: an LML auth rejection, or a failed ANALYZE. */
  error: null as string | null,
  /** The closing ANALYZE threw; run it by hand. */
  analyze_failed: false,
});
export type ExecuteSummary = ReturnType<typeof emptyExecuteSummary>;

/** A streak, or `failed`: an error the loop did not expect ended the run. */
export type AbortReason = StreakTrip | 'failed';

const ABORT_MESSAGES: Record<AbortReason, string> = {
  failed: 'an error ended the run; see `error` in the summary',
  lml_unanswered: 'consecutive albums went unanswered by LML; it is probably down',
  release_not_found: 'consecutive release fetches returned 404; Discogs is probably shedding',
  write_failed: 'consecutive writes failed; the database is probably unreachable',
};

/** Thrown after the accounting when a streak tripped or an error ended the run; `cause` is that error. */
export class FillAbortError extends Error {
  constructor(
    readonly trip: AbortReason,
    /** The summary as the run ended, `next_run` included. */
    readonly summary: ExecuteSummary,
    options?: { cause?: unknown }
  ) {
    super(`album-metadata-extended-fill aborted: ${ABORT_MESSAGES[trip]}`, options);
    this.name = 'FillAbortError';
  }
}

/** Hooks the job passes in: the stop flag, and a way to read the summary as it stands. */
export interface ExecuteControl {
  shouldStop(): boolean;
  /** Called once at the start; `current()` brings `next_run` up to date and returns the summary. */
  onProgress(current: () => ExecuteSummary): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Fill every candidate in order. Returns the summary. A tripped streak, or any
 * error the loop throws (an `LmlAuthError`, say), still gets the accounting
 * and the ANALYZE, then throws `FillAbortError` with `summary` current; so
 * does a failed ANALYZE.
 */
export const executeFill = async (
  candidates: readonly FillCandidate[],
  lml: LmlFetcher,
  options: ExecuteOptions,
  control: ExecuteControl
): Promise<ExecuteSummary> => {
  const retryOnly = options.albumIds.length > 0 && options.afterAlbumId === 0;
  const summary = emptyExecuteSummary(retryOnly, options.afterAlbumId);
  const candidateIds = candidates.map((c) => c.album_id);
  const carriedIds: number[] = [];
  const prior = { releaseIds: new Set(options.notFoundReleaseIds), artistIds: new Set(options.notFoundArtistIds) };
  const answered = { release: new Set<number>(), artist: new Set<number>() };
  const suspected = { release: new Set<number>(), artist: new Set<number>() };
  const plan = (): ExecuteSummary => {
    const p = planResume({
      candidateIds,
      processed: summary.processed,
      carriedIds,
      afterAlbumId: options.afterAlbumId,
      retryOnly,
    });
    summary.resume_after_album_id = p.resumeAfterAlbumId;
    summary.carried_album_ids = p.pending.slice(0, CARRIED_IDS_CAP);
    summary.next_run = p.albums && {
      ...p.albums,
      EXTENDED_FILL_NOT_FOUND_RELEASE_IDS: planNotFound(
        options.notFoundReleaseIds,
        answered.release,
        suspected.release
      ),
      EXTENDED_FILL_NOT_FOUND_ARTIST_IDS: planNotFound(options.notFoundArtistIds, answered.artist, suspected.artist),
    };
    return summary;
  };
  const record = (albumId: number, album: AlbumResult): void => {
    summary.outcomes[album.outcome] += 1;
    summary.artist[album.artist] += 1;
    album.filled.forEach((c) => (summary.filled_by_column[c] += 1));
    album.tooLong.forEach((c) => (summary.too_long[c] += 1));
    if (album.carried) {
      carriedIds.push(albumId);
    }
    if (album.releaseId !== undefined && !NO_RELEASE_ANSWER.has(album.outcome)) {
      (album.outcome === 'release_not_found_suspected' ? suspected : answered).release.add(album.releaseId);
    }
    if (album.artistId !== undefined && album.artist !== 'unanswered' && album.artist !== 'not_asked') {
      (album.artist === 'not_found_suspected' ? suspected : answered).artist.add(album.artistId);
    }
  };

  control.onProgress(plan);
  let streaks = NO_STREAKS;
  let failure: unknown;
  const advance = (album: Pick<AlbumResult, 'outcome' | 'artist'>): boolean => {
    const step = advanceStreaks(streaks, album, options.limits);
    streaks = step.streaks;
    if (step.trip) {
      summary.abort = step.trip;
      summary.stopped_early = true;
    }
    return step.trip !== undefined;
  };
  try {
    outer: for (let i = 0; i < candidates.length; i += PIN_BATCH_SIZE) {
      const batch = candidates.slice(i, i + PIN_BATCH_SIZE);
      const pins = await lookupBatchPins(batch, lml);
      // One failed pins call is one unanswered call, however many albums it covered.
      if ([...pins.values()].some((p) => !p.ok) && advance({ outcome: 'pin_unanswered', artist: 'not_asked' })) {
        break;
      }
      for (const candidate of batch) {
        if (control.shouldStop()) {
          summary.stopped_early = true;
          break outer;
        }
        const album = await fillAlbum(candidate, lml, pins.get(candidate.album_id), prior);
        summary.processed += 1;
        summary.last_album_id = candidate.album_id;
        record(candidate.album_id, album);
        if (album.outcome !== 'pin_unanswered' && advance(album)) {
          break outer;
        }
      }
      log('info', 'batch_done', `batch ${i / PIN_BATCH_SIZE + 1}: ${summary.processed} albums so far`, {
        processed: summary.processed,
        next_run: plan().next_run,
      });
    }
  } catch (err) {
    failure = err;
    summary.error = message(err);
    summary.stopped_early = true;
  }
  summary.reached_end =
    !summary.stopped_early && (retryOnly || options.maxAlbums === 0 || candidates.length < options.maxAlbums);
  plan();
  if (summary.outcomes.filled > 0) {
    try {
      await analyzeAlbumMetadata();
    } catch (err) {
      summary.analyze_failed = true;
      summary.error ??= message(err);
      failure ??= err;
    }
  }
  if (summary.abort || failure !== undefined) {
    throw new FillAbortError(summary.abort ?? 'failed', summary, { cause: failure });
  }
  return summary;
};
