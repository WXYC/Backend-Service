/**
 * The pure half of the comp-letter backfill (BS#2834): the gate that decides whether the 52-row write may run.
 *
 * The gate is the safety argument for reading a letter out of an artist name at all. A slot renamed since the cutover
 * leaves its genre short a letter (or with a duplicate), and that must abort the run rather than leave one section
 * quietly unlettered. The database-facing half, including "nothing is written when the gate fails", is covered against
 * a real Postgres in `tests/integration/comp-letter-backfill.spec.js`.
 */

import { checkGate, type Candidate, type LetteredSlot } from '../../../../jobs/comp-letter-backfill/backfill';

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

/** Every lettered row in the table, the way `findLettered` reports it, for a shelf that has been fully applied. */
const letteredFrom = (rows: Candidate[]): LetteredSlot[] =>
  rows.flatMap(({ artist_id, genre_id, code_comp_letter }) =>
    code_comp_letter === null ? [] : [{ artist_id, genre_id, code_comp_letter }]
  );

/** A letter on a slot outside the 52: the catch-all's Soundtracks filing. */
const STRAY: LetteredSlot = { artist_id: 1087, genre_id: SOUNDTRACKS, code_comp_letter: 'V' };

describe('checkGate', () => {
  it('passes the full 52-slot shelf with nothing lettered yet', () => {
    expect(checkGate(fullShelf(), [])).toEqual({ failures: [], alreadyApplied: false });
  });

  it.each<[string, () => [Candidate[], LetteredSlot[]], RegExp[]]>([
    [
      '51 rows (a Rock section renamed away)',
      () => [without(fullShelf(), 'Rock', 'Q'), []],
      [/expected 52 .* found 51/, /Rock: expected 26 .* found 25/, /Rock: missing Q/],
    ],
    [
      'a duplicate letter (two Soundtracks sections end " - P")',
      () => [[...without(fullShelf(), 'Soundtracks', 'Q'), slot('Soundtracks', 'P', 2999)], []],
      [/Soundtracks: missing Q/, /Soundtracks: duplicate P/],
    ],
    [
      'a missing genre entirely',
      () => [fullShelf().filter((row) => row.genre_name === 'Rock'), []],
      [/expected 52 .* found 26/, /Soundtracks: expected 26 .* found 0/],
    ],
    [
      "a Soundtracks-named section filed under Rock, standing in for Rock's renamed C",
      () => [
        [
          ...without(fullShelf(), 'Rock', 'C'),
          { ...slot('Soundtracks', 'C', 2002), genre_id: ROCK, genre_name: 'Rock' },
        ],
        [],
      ],
      [/Rock C \(artist 2002\): name 'Soundtracks - C' is not 'Various Artists - Rock - C'/],
    ],
    [
      'one slot already lettered',
      () => {
        const rows = fullShelf().map((row, i) => (i === 7 ? { ...row, code_comp_letter: row.letter } : row));
        return [rows, letteredFrom(rows)];
      },
      [/already carries code_comp_letter/],
    ],
    [
      'every slot lettered, one with a different letter than its name',
      () => {
        const rows = fullShelf().map((row, i) => ({ ...row, code_comp_letter: i === 3 ? 'Z' : row.letter }));
        return [rows, letteredFrom(rows)];
      },
      [/already carries code_comp_letter/],
    ],
    [
      'a letter on a slot outside the 52, before any run',
      () => [fullShelf(), [STRAY]],
      [/artist 1087 in genre 12 carries code_comp_letter 'V' but is not a candidate/],
    ],
    [
      'a letter on a slot outside the 52, after a completed run',
      () => {
        const rows = fullShelf().map((row) => ({ ...row, code_comp_letter: row.letter }));
        return [rows, [...letteredFrom(rows), STRAY]];
      },
      [/artist 1087 in genre 12 carries code_comp_letter 'V' but is not a candidate/],
    ],
  ])('aborts on %s', (_label, input, expected) => {
    const { failures, alreadyApplied } = checkGate(...input());
    expect(alreadyApplied).toBe(false);
    for (const pattern of expected) {
      expect(failures).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
    }
  });

  it('reports a completed run as already applied, not as a failure, so a re-run is a no-op', () => {
    const applied = fullShelf().map((row) => ({ ...row, code_comp_letter: row.letter }));
    expect(checkGate(applied, letteredFrom(applied))).toEqual({ failures: [], alreadyApplied: true });
  });

  it('accepts the name forms case- and whitespace-insensitively, since the legacy catalog supplied them', () => {
    const rows = fullShelf().map((row, i) => (i === 0 ? { ...row, artist_name: ' various artists - ROCK - a ' } : row));
    expect(checkGate(rows, [])).toEqual({ failures: [], alreadyApplied: false });
  });
});
