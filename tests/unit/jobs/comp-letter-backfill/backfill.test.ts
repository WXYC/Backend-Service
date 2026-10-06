/**
 * The pure halves of the comp-letter backfill (BS#2834): the gate that decides whether the 52-row write may run, and
 * the advisory cross-check against the frozen tubafrenzy dump.
 *
 * The gate is the safety argument for reading a letter out of an artist name at all. A slot renamed since the cutover
 * leaves its genre short a letter (or with a duplicate), and that must abort the run rather than leave one section
 * quietly unlettered. The database-facing half, including "nothing is written when the gate fails", is covered against
 * a real Postgres in `tests/integration/comp-letter-backfill.spec.js`.
 */

import {
  checkGate,
  crossCheck,
  type Candidate,
  type LegacyRelease,
  type LetteredSlot,
} from '../../../../jobs/comp-letter-backfill/backfill';
import { legacyReleasesById } from '../../../../jobs/comp-letter-backfill/legacy';

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

describe('crossCheck', () => {
  const candidates = [slot('Rock', 'L', 1011), slot('Soundtracks', 'K', 2010)];
  const filed = (call_letters: string | null, genre_id: number | null): LegacyRelease => ({ call_letters, genre_id });
  const legacy = new Map<number, LegacyRelease>([
    [500, filed('Z-L', ROCK)],
    [501, filed('Z-M', ROCK)], // another Rock section in the dump
    [502, filed('Z-L', SOUNDTRACKS)], // the right letter but the other genre
    [503, filed(null, null)], // in the dump, filed under a NULL or missing code
    [600, filed('Z-K', SOUNDTRACKS)],
    [601, filed('RO', ROCK)], // filed under a named artist in tubafrenzy
  ]);
  const under = (artist_id: number, genre_id: number, legacy_release_id: number) => ({
    artist_id,
    genre_id,
    legacy_release_id,
  });

  it('puts each release in exactly one bucket, and lists every disagreement without judging it', () => {
    const releases = [
      under(1011, ROCK, 500),
      under(1011, ROCK, 501),
      under(1011, ROCK, 502),
      under(1011, ROCK, 503),
      under(1011, ROCK, 1_000_007), // filed in Backend since the cutover
      under(2010, SOUNDTRACKS, 600),
      under(2010, SOUNDTRACKS, 601),
      under(2010, SOUNDTRACKS, 999), // a tubafrenzy-era id with no row in the dump
      under(4242, ROCK, 500), // not under a candidate slot: ignored
    ];

    const disagreement = (
      artist_id: number,
      genre_name: string,
      letter: string,
      id: number,
      call: string | null,
      genre: number | null
    ) => ({
      artist_id,
      genre_name,
      letter,
      legacy_release_id: id,
      legacy_call_letters: call,
      legacy_genre_id: genre,
    });
    expect(crossCheck(candidates, releases, legacy)).toEqual({
      agreed: 2,
      disagreements: [
        disagreement(1011, 'Rock', 'L', 501, 'Z-M', ROCK),
        disagreement(1011, 'Rock', 'L', 502, 'Z-L', SOUNDTRACKS),
        disagreement(1011, 'Rock', 'L', 503, null, null),
        disagreement(2010, 'Soundtracks', 'K', 601, 'RO', ROCK),
      ],
      notInDump: 1,
      backendMinted: 1,
    });
  });
});

describe('legacyReleasesById', () => {
  // Plain arrays: `for await` accepts a sync iterable, which is all the mapping needs here.
  const rows = (...items: (string | null)[][]) => items;
  // LIBRARY_RELEASE: ID at 0, LIBRARY_CODE_ID at 8.
  const release = (id: string, codeId: string | null) => [id, '1', null, 't', '1', '0', '0', null, codeId];

  it("maps each LIBRARY_RELEASE id to its LIBRARY_CODE's trimmed CALL_LETTERS and GENRE_ID", async () => {
    // LIBRARY_CODE: ID, GENRE_ID, CALL_LETTERS, ...
    const codes = rows(['10', '11', 'Z-L', '0'], ['11', '12', 'Z-K ', '0'], ['12', '11', 'RO', '12']);
    const releases = rows(
      release('500', '10'),
      release('600', '11'),
      release('601', '12'),
      release('602', null),
      release('603', '99')
    );

    expect(await legacyReleasesById(codes, releases)).toEqual(
      new Map([
        [500, { call_letters: 'Z-L', genre_id: 11 }],
        [600, { call_letters: 'Z-K', genre_id: 12 }],
        [601, { call_letters: 'RO', genre_id: 11 }],
        [602, { call_letters: null, genre_id: null }], // NULL code: in the dump, code unknown
        [603, { call_letters: null, genre_id: null }], // dangling code: same
      ])
    );
  });

  it.each([
    ['LIBRARY_CODE', rows(), rows(release('500', '10'))],
    ['LIBRARY_RELEASE', rows(['10', '11', 'Z-L']), rows()],
  ])(
    'refuses a dump with no %s rows rather than letting every release read as "not in dump"',
    async (table, codes, releases) => {
      await expect(legacyReleasesById(codes, releases)).rejects.toThrow(`the dump has no ${table} rows`);
    }
  );
});
