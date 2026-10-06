/**
 * The pure half of the comp-letter backfill (BS#2834): the gate that decides whether the 52-row write may run.
 *
 * The gate is the safety argument for reading a letter out of an artist name at all. A slot renamed since the cutover
 * leaves its genre short a letter (or with a duplicate), and that must abort the run rather than leave one section
 * quietly unlettered. The database-facing half, including "nothing is written when the gate fails", is covered against
 * a real Postgres in `tests/integration/comp-letter-backfill.spec.js`.
 */

import { checkGate, type Candidate } from '../../../../jobs/comp-letter-backfill/backfill';

const ROCK = 11;
const SOUNDTRACKS = 12;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const slot = (genre: 'Rock' | 'Soundtracks', letter: string, artistId: number): Candidate => ({
  artist_id: artistId,
  genre_id: genre === 'Rock' ? ROCK : SOUNDTRACKS,
  genre_name: genre,
  artist_name: genre === 'Rock' ? `Various Artists - Rock - ${letter}` : `Soundtracks - ${letter}`,
  letter,
  code_comp_letter: null,
});

/** The production shape: 26 Rock sections and 26 Soundtracks sections, A-Z each, none lettered yet. */
const fullShelf = (): Candidate[] => [
  ...ALPHABET.map((letter, i) => slot('Rock', letter, 1000 + i)),
  ...ALPHABET.map((letter, i) => slot('Soundtracks', letter, 2000 + i)),
];

const without = (rows: Candidate[], genre: string, letter: string) =>
  rows.filter((row) => !(row.genre_name === genre && row.letter === letter));

describe('checkGate', () => {
  it('passes the full 52-slot shelf with nothing lettered yet', () => {
    expect(checkGate(fullShelf())).toEqual({ failures: [], alreadyApplied: false });
  });

  it.each<[string, () => Candidate[], RegExp[]]>([
    [
      '51 rows (a Rock section renamed away)',
      () => without(fullShelf(), 'Rock', 'Q'),
      [/expected 52 .* found 51/, /Rock: expected 26 .* found 25/, /Rock: missing Q/],
    ],
    [
      'a duplicate letter (two Soundtracks sections end " - P")',
      () => [...without(fullShelf(), 'Soundtracks', 'Q'), slot('Soundtracks', 'P', 2999)],
      [/Soundtracks: missing Q/, /Soundtracks: duplicate P/],
    ],
    [
      'a missing genre entirely',
      () => fullShelf().filter((row) => row.genre_name === 'Rock'),
      [/expected 52 .* found 26/, /Soundtracks: expected 26 .* found 0/],
    ],
    [
      'one slot already lettered',
      () => fullShelf().map((row, i) => (i === 7 ? { ...row, code_comp_letter: row.letter } : row)),
      [/already carries code_comp_letter/],
    ],
    [
      'every slot lettered, one with a different letter than its name',
      () => fullShelf().map((row, i) => ({ ...row, code_comp_letter: i === 3 ? 'Z' : row.letter })),
      [/already carries code_comp_letter/],
    ],
  ])('aborts on %s', (_label, rows, expected) => {
    const { failures, alreadyApplied } = checkGate(rows());
    expect(alreadyApplied).toBe(false);
    for (const pattern of expected) {
      expect(failures).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
    }
  });

  it('reports a completed run as already applied, not as a failure, so a re-run is a no-op', () => {
    const applied = fullShelf().map((row) => ({ ...row, code_comp_letter: row.letter }));
    expect(checkGate(applied)).toEqual({ failures: [], alreadyApplied: true });
  });
});
