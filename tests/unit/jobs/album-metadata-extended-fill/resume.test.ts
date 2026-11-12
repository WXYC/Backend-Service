/**
 * Resume and the stop streaks for the BS#1442 extended fill.
 *
 * `planResume` is the bio fill's (BS#2786): the cursor moves past every album
 * asked, and what was asked but not settled rides along as the next run's
 * list. The streaks are per album: 10 unanswered in a row means LML is down,
 * 10 release 404s in a row means Discogs is shedding (a 404 is not proof a
 * release is gone), and 10 failed writes in a row means the database is.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect } from '@jest/globals';
import type { AlbumResult } from '../../../../jobs/album-metadata-extended-fill/fill';
import {
  CARRIED_IDS_CAP,
  NO_STREAKS,
  advanceStreaks,
  planNotFound,
  planResume,
  type Streaks,
} from '../../../../jobs/album-metadata-extended-fill/resume';

describe('planResume', () => {
  it('moves the cursor past the last album asked and carries the unsettled ones', () => {
    expect(
      planResume({ candidateIds: [10, 20, 30, 40], processed: 3, carriedIds: [20], afterAlbumId: 5, retryOnly: false })
    ).toEqual({
      pending: [20],
      resumeAfterAlbumId: 19,
      albums: { EXTENDED_FILL_ALBUM_AFTER_ID: 30, EXTENDED_FILL_ALBUM_IDS: '20' },
    });
  });

  it('nothing asked: the cursor stays and nothing is carried', () => {
    expect(
      planResume({ candidateIds: [10, 20], processed: 0, carriedIds: [], afterAlbumId: 5, retryOnly: false }).albums
    ).toEqual({ EXTENDED_FILL_ALBUM_AFTER_ID: 5, EXTENDED_FILL_ALBUM_IDS: '' });
  });

  it('lists again the carried-list albums below the cursor that a stopped run never reached', () => {
    // A cursor run of 100 carrying [3, 7]: it asked 3 and stopped.
    const plan = planResume({
      candidateIds: [3, 7, 101],
      processed: 1,
      carriedIds: [],
      afterAlbumId: 100,
      retryOnly: false,
    });

    expect(plan.albums).toEqual({ EXTENDED_FILL_ALBUM_AFTER_ID: 100, EXTENDED_FILL_ALBUM_IDS: '7' });
  });

  it('a retry run keeps cursor 0 and lists what it left, or returns no next run', () => {
    const left = planResume({ candidateIds: [3, 7], processed: 2, carriedIds: [7], afterAlbumId: 0, retryOnly: true });
    const done = planResume({ candidateIds: [3, 7], processed: 2, carriedIds: [], afterAlbumId: 0, retryOnly: true });

    expect(left).toMatchObject({
      resumeAfterAlbumId: null,
      albums: { EXTENDED_FILL_ALBUM_AFTER_ID: 0, EXTENDED_FILL_ALBUM_IDS: '7' },
    });
    expect(done.albums).toBeNull();
  });

  it('carries one full list and stops the cursor just below the first album that did not fit', () => {
    const ids = Array.from({ length: CARRIED_IDS_CAP + 5 }, (_, i) => i + 1);

    const plan = planResume({
      candidateIds: ids,
      processed: ids.length,
      carriedIds: ids,
      afterAlbumId: 0,
      retryOnly: false,
    });

    expect(plan.albums?.EXTENDED_FILL_ALBUM_IDS.split(',')).toHaveLength(CARRIED_IDS_CAP);
    expect(plan.albums?.EXTENDED_FILL_ALBUM_AFTER_ID).toBe(CARRIED_IDS_CAP);
  });
});

describe('planNotFound', () => {
  it.each([
    ['keeps a given id LML did not answer again', [5], [], [], '5'],
    ['drops a given id LML answered again (settled or cleared)', [5], [5], [], ''],
    ["adds this run's first 404s, sorted and distinct", [9], [], [7, 3, 7], '3,7,9'],
  ] as const)('%s', (_label, given, asked, newly, expected) => {
    expect(planNotFound(given, new Set(asked), newly)).toBe(expected);
  });

  it('caps the list', () => {
    const many = Array.from({ length: CARRIED_IDS_CAP + 1 }, (_, i) => i + 1);

    expect(planNotFound([], new Set(), many).split(',')).toHaveLength(CARRIED_IDS_CAP);
  });
});

describe('advanceStreaks', () => {
  const LIMITS = { maxConsecutiveUnanswered: 3, maxConsecutiveNotFound: 3, maxConsecutiveWriteFailures: 3 };
  const album = (outcome: AlbumResult['outcome'], artist: AlbumResult['artist'] = 'answered') => ({ outcome, artist });
  const AT_TWO: Streaks = { unanswered: 2, notFound: 2, writeFailed: 2 };

  it.each([
    // outcome, artist, expected streaks from {2,2,2}
    ['release_unanswered', 'not_asked', { unanswered: 3, notFound: 2, writeFailed: 2 }, 'lml_unanswered'],
    ['pin_unanswered', 'not_asked', { unanswered: 3, notFound: 2, writeFailed: 2 }, 'lml_unanswered'],
    ['filled', 'unanswered', { unanswered: 3, notFound: 2, writeFailed: 0 }, 'lml_unanswered'],
    ['release_not_found_suspected', 'not_asked', { unanswered: 0, notFound: 3, writeFailed: 2 }, 'release_not_found'],
    ['release_not_found', 'not_asked', { unanswered: 0, notFound: 3, writeFailed: 2 }, 'release_not_found'],
    ['write_failed', 'answered', { unanswered: 0, notFound: 0, writeFailed: 3 }, 'write_failed'],
    ['filled', 'answered', { unanswered: 0, notFound: 0, writeFailed: 0 }, undefined],
    ['release_changed', 'not_asked', { unanswered: 0, notFound: 0, writeFailed: 0 }, undefined],
    ['nothing_new', 'not_found_suspected', { unanswered: 0, notFound: 0, writeFailed: 2 }, undefined],
    // No LML call: says nothing about LML or the database.
    ['no_release_id', 'not_asked', { unanswered: 2, notFound: 2, writeFailed: 2 }, undefined],
    ['pin_disagrees', 'not_asked', { unanswered: 2, notFound: 2, writeFailed: 2 }, undefined],
  ] as const)('%s (artist %s) -> %o, trips %s', (outcome, artist, expected, trip) => {
    const step = advanceStreaks(AT_TWO, album(outcome, artist), LIMITS);

    expect(step.streaks).toEqual(expected);
    expect(step.trip).toBe(trip);
  });

  it('a limit of 0 never trips', () => {
    const off = { maxConsecutiveUnanswered: 0, maxConsecutiveNotFound: 0, maxConsecutiveWriteFailures: 0 };

    expect(advanceStreaks({ ...NO_STREAKS, unanswered: 99 }, album('release_unanswered'), off).trip).toBeUndefined();
  });
});
