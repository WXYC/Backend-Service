/**
 * `planResume` — where a run leaves its work for the next one (BS#2786).
 *
 * The frozen cursor alone never skips a row, but it stalls: an album LML never
 * answers for pins every later run to the same starting point, and each run's
 * window fills up with rows it already settled. The plan instead moves the
 * cursor past everything the run asked and carries the albums it could not
 * settle as the next run's list; past 200 it carries the first 200 and stops
 * the cursor below the rest. `resumeAfterAlbumId` is still reported, a
 * list-free cursor that never skips but stalls; `nextRun` is what to run.
 *
 * Pure, so every rule is a row here rather than a scripted run.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect } from '@jest/globals';
import { INDETERMINATE_IDS_REPORT_CAP, planResume } from '../../../../jobs/album-metadata-bio-fill/job';

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('planResume', () => {
  it.each([
    // [label, state, pending, resumeAfterAlbumId, next cursor, next list]
    ['a run that settled everything', { candidateIds: ids(1, 6), processed: 6 }, [], 6, 6, ''],
    // The stall fix: the cursor moves past an unsettled album, which rides
    // along as the list rather than holding every later run back.
    [
      'a run that left one album unsettled',
      { candidateIds: ids(1, 6), processed: 6, unsettledIds: [3] },
      [3],
      2,
      6,
      '3',
    ],
    // Rows above the last album asked are the cursor's, not the list's.
    ['a run that stopped early', { candidateIds: ids(1, 6), processed: 4, unsettledIds: [2] }, [2], 1, 4, '2'],
    [
      'a run that stopped before its first batch',
      { candidateIds: ids(101, 104), processed: 0, afterAlbumId: 100 },
      [],
      100,
      100,
      '',
    ],
    // Every album in a no-bio streak looked settled, and a breaker shed may
    // have hit any of them. They are listed, and the fallback sits below them.
    [
      'a run the no-bio guard aborted',
      { candidateIds: ids(1, 10), processed: 8, unsettledIds: [1], noBioStreakStart: 4 },
      [1, 5, 6, 7, 8],
      0,
      8,
      '1,5,6,7,8',
    ],
    // A carried list sits below the cursor and is asked first.
    [
      'a carried list, all settled',
      { candidateIds: [40, 90, 501, 502], processed: 4, afterAlbumId: 500 },
      [],
      502,
      502,
      '',
    ],
    [
      'a carried album still unsettled',
      { candidateIds: [40, 90, 501, 502], processed: 4, unsettledIds: [90], afterAlbumId: 500 },
      [90],
      89,
      502,
      '90',
    ],
    // Stopped inside the carried part: the unreached carried album stays
    // listed, and the cursor does not move.
    [
      'a run stopped inside its carried list',
      { candidateIds: [40, 90, 501, 502], processed: 1, afterAlbumId: 500 },
      [90],
      89,
      500,
      '90',
    ],
  ] as const)('%s', (_label, state, pending, resumeAfterAlbumId, cursor, list) => {
    const plan = planResume({ unsettledIds: [], afterAlbumId: 0, retryOnly: false, ...state });

    expect(plan.pending).toEqual(pending);
    expect(plan.resumeAfterAlbumId).toBe(resumeAfterAlbumId);
    expect(plan.nextRun).toEqual({ BIO_FILL_ALBUM_AFTER_ID: cursor, BIO_FILL_ALBUM_IDS: list });
  });

  it('never lists an album twice, when an unanswered album sits inside a no-bio streak', () => {
    const plan = planResume({
      candidateIds: ids(1, 6),
      processed: 6,
      unsettledIds: [4],
      noBioStreakStart: 2,
      afterAlbumId: 0,
      retryOnly: false,
    });

    expect(plan.pending).toEqual([3, 4, 5, 6]);
  });

  // Rewinding to the first pending album when the list overflowed made the
  // next run re-ask the whole residue above it; at a sustained 9% unanswered
  // rate that overflowed again every run and the chain never finished.
  it('carries the first full list and sets the cursor just below the first album it could not carry', () => {
    const plan = planResume({
      candidateIds: ids(1, 300),
      processed: 300,
      unsettledIds: ids(50, 50 + INDETERMINATE_IDS_REPORT_CAP),
      afterAlbumId: 0,
      retryOnly: false,
    });

    expect(plan.pending).toHaveLength(INDETERMINATE_IDS_REPORT_CAP + 1);
    // Every pending album at or below the cursor is listed, and the one that
    // did not fit is above it, so nothing is skipped.
    expect(plan.nextRun).toEqual({
      BIO_FILL_ALBUM_AFTER_ID: 50 + INDETERMINATE_IDS_REPORT_CAP - 1,
      BIO_FILL_ALBUM_IDS: ids(50, 50 + INDETERMINATE_IDS_REPORT_CAP - 1).join(','),
    });
    // The list-free fallback is unchanged: below the first pending album.
    expect(plan.resumeAfterAlbumId).toBe(49);
  });

  it.each([
    [
      'albums left',
      { processed: 1, unsettledIds: [40] },
      [40, 41],
      { BIO_FILL_ALBUM_AFTER_ID: 0, BIO_FILL_ALBUM_IDS: '40,41' },
    ],
    ['nothing left', { processed: 2 }, [], null],
  ] as const)(
    'gives a retry run, which has no cursor, the next retry when it leaves %s',
    (_label, state, pending, nextRun) => {
      const plan = planResume({ candidateIds: [40, 41], unsettledIds: [], afterAlbumId: 0, retryOnly: true, ...state });

      expect(plan.pending).toEqual(pending);
      expect(plan.resumeAfterAlbumId).toBeNull();
      expect(plan.nextRun).toEqual(nextRun);
    }
  );
});
