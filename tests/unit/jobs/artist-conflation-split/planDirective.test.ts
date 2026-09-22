/**
 * Refusal-arithmetic tests for the split job's planner (BS#2645), against a
 * scripted transaction stub.
 *
 * The case that earns this file: on an idempotent re-run the split genre's
 * crossreference row is already gone, and the "would leave no membership"
 * check must count the filings that would REMAIN (filed minus filed-and-
 * splitting), not filed minus REQUESTED — the conflation that made a
 * completed directive report a second, false refusal on top of the correct
 * "not filed under split genre" one.
 */

import { planDirective, REPORTED_SITES } from '../../../../jobs/artist-conflation-split/split';

type Row = Record<string, unknown>;

/** A tx whose execute() answers from a queue, in planDirective's query order:
 *  artists row, gac rows, one library count per split genre, then one count
 *  per REPORTED_SITES entry. */
const scriptedTx = (artist: Row[], gac: Row[], libraryCounts: number[]) => {
  const responses: Row[][] = [
    artist,
    gac,
    ...libraryCounts.map((n) => [{ n }]),
    ...REPORTED_SITES.map(() => [{ n: 0 }]),
  ];
  return {
    execute: jest.fn(() => Promise.resolve(responses.shift() ?? [])),
  };
};

const directive = (overrides = {}) => ({
  artistId: 431,
  keepGenreId: 6,
  splitGenreIds: [11],
  clearIdentity: false,
  ...overrides,
});

describe('planDirective refusal arithmetic', () => {
  test('a healthy two-filing directive has no refusals', async () => {
    const tx = scriptedTx(
      [{ artist_name: 'Isis' }],
      [
        { genre_id: 6, artist_genre_code: 1 },
        { genre_id: 11, artist_genre_code: 13 },
      ],
      [1]
    );

    const plan = await planDirective(directive(), tx as never);

    expect(plan.refusals).toEqual([]);
    expect(plan.perGenre).toEqual([{ genreId: 11, artistGenreCode: 13, libraryRows: 1 }]);
  });

  test('an idempotent re-run refuses ONLY for the missing filing', async () => {
    // The split genre's crossreference row is gone; the kept filing remains.
    const tx = scriptedTx([{ artist_name: 'Isis' }], [{ genre_id: 6, artist_genre_code: 1 }], [0]);

    const plan = await planDirective(directive(), tx as never);

    expect(plan.refusals).toEqual([expect.stringContaining('not filed under split genre 11')]);
  });

  test('splitting every filed genre refuses for the emptied kept row', async () => {
    // Keep genre not filed at all, split genre filed: both refusals apply —
    // the membership check must still fire when it is genuinely true.
    const tx = scriptedTx([{ artist_name: 'Isis' }], [{ genre_id: 11, artist_genre_code: 13 }], [1]);

    const plan = await planDirective(directive(), tx as never);

    expect(plan.refusals).toEqual(
      expect.arrayContaining([
        expect.stringContaining('not filed under keep genre 6'),
        expect.stringContaining('no genre membership'),
      ])
    );
  });
});
