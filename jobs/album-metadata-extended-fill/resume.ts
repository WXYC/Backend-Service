/**
 * Where a run leaves its work, and the streaks it stops itself on (BS#1442).
 * Pure, so each rule is a row in `resume.test.ts`. `planResume` is copied from
 * `jobs/album-metadata-bio-fill/job.ts` (BS#2786) with the shape review
 * approved there; the streaks are per album, since these are single calls, not
 * bulk batches.
 */

import type { AlbumResult } from './fill.js';

/** How many ids one carried list holds; the job's list parser takes as many. */
export const CARRIED_IDS_CAP = 200;

/** The environment that starts the next run where this one left off. */
export interface NextRun {
  EXTENDED_FILL_ALBUM_AFTER_ID: number;
  EXTENDED_FILL_ALBUM_IDS: string;
  /** Release ids that 404'd once; a second 404 next run settles them. */
  EXTENDED_FILL_NOT_FOUND_RELEASE_IDS: string;
  /** Artist ids that 404'd once; likewise. */
  EXTENDED_FILL_NOT_FOUND_ARTIST_IDS: string;
}

export interface ResumePlan {
  /** Every album the next run must ask that its cursor does not reach, in `album_id` order. */
  pending: number[];
  /** A cursor safe on its own, below every pending album. `null` on a retry run. */
  resumeAfterAlbumId: number | null;
  /** The album part of `next_run`; null when a retry run left nothing. */
  albums: Pick<NextRun, 'EXTENDED_FILL_ALBUM_AFTER_ID' | 'EXTENDED_FILL_ALBUM_IDS'> | null;
}

/**
 * The cursor moves past the last album asked, and everything asked but not
 * settled rides along as the next run's list. More than one list's worth
 * carries the first list and stops the cursor just below the rest.
 */
export const planResume = (state: {
  /** Enumerated album ids, in the order they were asked. */
  candidateIds: readonly number[];
  /** How many of them were asked. */
  processed: number;
  /** Asked but not settled. */
  carriedIds: readonly number[];
  afterAlbumId: number;
  /** A list with no cursor: only the listed albums, and no cursor to move. */
  retryOnly: boolean;
}): ResumePlan => {
  const { candidateIds, processed, afterAlbumId, retryOnly } = state;
  const cursor = processed > 0 ? Math.max(afterAlbumId, candidateIds[processed - 1]) : afterAlbumId;
  // Albums never reached above the cursor are the cursor's; below it, only a
  // carried list's albums can be, and those have to be listed again.
  const unreached = candidateIds.slice(processed).filter((id) => retryOnly || id <= cursor);
  const pending = [...new Set([...state.carriedIds, ...unreached])].sort((a, b) => a - b);
  if (retryOnly) {
    return {
      pending,
      resumeAfterAlbumId: null,
      albums:
        pending.length > 0 ? { EXTENDED_FILL_ALBUM_AFTER_ID: 0, EXTENDED_FILL_ALBUM_IDS: pending.join(',') } : null,
    };
  }
  const carried = pending.slice(0, CARRIED_IDS_CAP);
  const nextCursor = pending.length > carried.length ? pending[carried.length] - 1 : cursor;
  return {
    pending,
    resumeAfterAlbumId: pending.length > 0 ? pending[0] - 1 : cursor,
    albums: { EXTENDED_FILL_ALBUM_AFTER_ID: nextCursor, EXTENDED_FILL_ALBUM_IDS: carried.join(',') },
  };
};

/**
 * The not-found ids the next run needs: this run's first 404s, plus the ones
 * it was given and LML did not answer again (unreached, or unanswered). An id
 * answered again leaves the list: a second 404 settled it, and a 200 cleared
 * it. Capped like an album list; an id cut off only costs its album one more
 * carried run.
 */
export const planNotFound = (
  given: readonly number[],
  answered: ReadonlySet<number>,
  newlySuspected: Iterable<number>
) =>
  [...new Set([...given.filter((id) => !answered.has(id)), ...newlySuspected])]
    .sort((a, b) => a - b)
    .slice(0, CARRIED_IDS_CAP)
    .join(',');

export interface StreakLimits {
  maxConsecutiveUnanswered: number;
  maxConsecutiveNotFound: number;
  maxConsecutiveWriteFailures: number;
}

export interface Streaks {
  unanswered: number;
  notFound: number;
  writeFailed: number;
}

export const NO_STREAKS: Streaks = { unanswered: 0, notFound: 0, writeFailed: 0 };

export type StreakTrip = 'lml_unanswered' | 'release_not_found' | 'write_failed';

const UNANSWERED = new Set(['release_unanswered', 'pin_unanswered']);
const NOT_FOUND = new Set(['release_not_found_suspected', 'release_not_found']);
/** Outcomes that made no LML call, so they say nothing about LML. */
const NO_CALL = new Set(['no_release_id', 'pin_disagrees']);
const WROTE = new Set(['filled', 'release_changed']);

/**
 * One album's effect on the streaks. A streak at its limit trips (a limit of
 * 0 disables it), checked in the order LML, 404, database.
 *
 * - unanswered: a release or pins call that went unanswered, or an artist
 *   call that did; reset by any answered call.
 * - not found: a release 404 (a run of them means Discogs is shedding);
 *   reset by an answered release.
 * - write failed: an UPDATE that threw; reset by one that ran.
 */
export const advanceStreaks = (
  streaks: Streaks,
  album: Pick<AlbumResult, 'outcome' | 'artist'>,
  limits: StreakLimits
): { streaks: Streaks; trip?: StreakTrip } => {
  const { outcome } = album;
  const unansweredNow = UNANSWERED.has(outcome) || album.artist === 'unanswered';
  const answered = !unansweredNow && !NO_CALL.has(outcome);
  const releaseAnswered = answered && !NOT_FOUND.has(outcome);
  const next: Streaks = {
    unanswered: unansweredNow ? streaks.unanswered + 1 : answered ? 0 : streaks.unanswered,
    notFound: NOT_FOUND.has(outcome) ? streaks.notFound + 1 : releaseAnswered ? 0 : streaks.notFound,
    writeFailed: outcome === 'write_failed' ? streaks.writeFailed + 1 : WROTE.has(outcome) ? 0 : streaks.writeFailed,
  };
  const at = (count: number, limit: number) => limit > 0 && count >= limit;
  if (at(next.unanswered, limits.maxConsecutiveUnanswered)) {
    return { streaks: next, trip: 'lml_unanswered' };
  }
  if (at(next.notFound, limits.maxConsecutiveNotFound)) {
    return { streaks: next, trip: 'release_not_found' };
  }
  if (at(next.writeFailed, limits.maxConsecutiveWriteFailures)) {
    return { streaks: next, trip: 'write_failed' };
  }
  return { streaks: next };
};
