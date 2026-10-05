/**
 * BS#2833 (epic BS#2828) -- `genre_artist_crossreference.code_comp_letter`, the compilation letter of a
 * Rock/Soundtracks `V/A` shelf slot, and the three rules the database enforces on it. The unit tier cannot
 * see any of this: it is constraint behaviour.
 *
 *   - `genre_artist_crossreference_code_comp_letter_shape_ck`: exactly one upper-case letter,
 *   - `genre_artist_crossreference_code_comp_letter_slot_ck`: a letter only on a slot with `artist_genre_code = 0`,
 *   - `genre_artist_crossreference_genre_comp_letter_key`: a letter is unique within a genre.
 *
 * The fourth rule, "a letter belongs to a `V/A` artist", cannot be a CHECK (it reads another table) and is not a
 * trigger (nothing writes the column once the backfill has run), so it is asserted here as a query over every row.
 * Before the backfill it passes vacuously.
 *
 * Every row is removed in `afterEach`.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ROCK = 11;
const GENRE_OTHER = 12; // a second genre, present in the integration fixture
const PROBE_PREFIX = 'BS#2833 Probe';

describe('genre_artist_crossreference.code_comp_letter (real PG)', () => {
  let sql;
  const artistIds = [];

  const seedArtist = async (label, codeLetters = 'V/A') => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${`${PROBE_PREFIX} ${label}`}, ${`${PROBE_PREFIX} ${label}`}, ${codeLetters})
      RETURNING id
    `;
    artistIds.push(row.id);
    return row.id;
  };

  const insertSlot = (artistId, genreId, artistGenreCode, letter) => sql`
    INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code, code_comp_letter)
    VALUES (${artistId}, ${genreId}, ${artistGenreCode}, ${letter})
  `;

  const violation = async (promise) => {
    try {
      await promise;
    } catch (e) {
      return e;
    }
    return undefined;
  };

  beforeAll(() => {
    sql = getTestDb();
  });

  afterEach(async () => {
    if (artistIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id = ANY(${artistIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ANY(${artistIds})`;
      artistIds.length = 0;
    }
  });

  test("accepts 'M' on a V/A slot with artist_genre_code = 0", async () => {
    const artistId = await seedArtist('Accept');
    await insertSlot(artistId, GENRE_ROCK, 0, 'M');

    const [row] = await sql`
      SELECT code_comp_letter FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id = ${artistId}
    `;
    expect(row.code_comp_letter).toBe('M');
  });

  test('a slot with no letter is unaffected by any of the three rules', async () => {
    const artistId = await seedArtist('Null', 'XA');
    await insertSlot(artistId, GENRE_ROCK, 12, null);
    await insertSlot(await seedArtist('Null Twin', 'XB'), GENRE_ROCK, 12, null);
  });

  test.each([
    ["lower-case 'm'", 'm'],
    ["two letters 'MM'", 'MM'],
    ["a digit '1'", '1'],
    ['an empty string', ''],
  ])('rejects %s (shape CHECK)', async (_label, letter) => {
    const artistId = await seedArtist('Shape');
    const err = await violation(insertSlot(artistId, GENRE_ROCK, 0, letter));

    expect(err).toBeDefined();
    // 23514 = check_violation; 22001 = string_data_right_truncation, which the varchar(1) raises first for 'MM'.
    expect(['23514', '22001']).toContain(err.code);
    if (err.code === '23514') expect(err.constraint_name).toBe('genre_artist_crossreference_code_comp_letter_shape_ck');
  });

  test('rejects a letter on a slot with artist_genre_code = 12 (slot CHECK)', async () => {
    const artistId = await seedArtist('Slot');
    const err = await violation(insertSlot(artistId, GENRE_ROCK, 12, 'M'));

    expect(err).toBeDefined();
    expect(err.code).toBe('23514');
    expect(err.constraint_name).toBe('genre_artist_crossreference_code_comp_letter_slot_ck');
  });

  test("rejects a second 'M' in the same genre (partial unique index)", async () => {
    await insertSlot(await seedArtist('First'), GENRE_ROCK, 0, 'M');
    const err = await violation(insertSlot(await seedArtist('Second'), GENRE_ROCK, 0, 'M'));

    expect(err).toBeDefined();
    expect(err.code).toBe('23505');
    expect(err.constraint_name).toBe('genre_artist_crossreference_genre_comp_letter_key');
  });

  test("allows 'M' in two different genres", async () => {
    await insertSlot(await seedArtist('Rock'), GENRE_ROCK, 0, 'M');
    await insertSlot(await seedArtist('Other'), GENRE_OTHER, 0, 'M');
  });

  test('every row with a code_comp_letter belongs to an artist whose code_letters is V/A', async () => {
    const offenders = await sql`
      SELECT gac.artist_id, gac.genre_id, gac.code_comp_letter, a.code_letters
        FROM ${sql(SCHEMA)}.genre_artist_crossreference gac
        JOIN ${sql(SCHEMA)}.artists a ON a.id = gac.artist_id
       WHERE gac.code_comp_letter IS NOT NULL
         AND a.code_letters IS DISTINCT FROM 'V/A'
    `;
    expect(offenders).toEqual([]);
  });
});
