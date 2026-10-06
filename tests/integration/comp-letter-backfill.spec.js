/**
 * The comp-letter backfill (BS#2834) against a real Postgres: the 52-row write, the gate that refuses to write
 * anything, and the re-run that is a no-op.
 *
 * Runs the REAL shipped `runBackfill` from `jobs/comp-letter-backfill/dist/backfill.cjs` (CI's Build step produces
 * it; locally, `npm run build --workspace=@wxyc/comp-letter-backfill` first). The module imports nothing at runtime:
 * it takes the postgres.js handle this spec passes it, so no drizzle mock is involved.
 *
 * Isolation: the gate counts EVERY Rock/Soundtracks V/A slot in the schema, so a stray row seeded by another spec
 * would change the count it checks. Each test therefore runs in a throwaway schema whose four tables are
 * `LIKE ... INCLUDING ALL` copies of the real ones, so the BS#2833 shape CHECK, slot CHECK and per-genre unique index
 * are present as the same backstop they are in production.
 */

const path = require('path');
const { getTestDb } = require('../utils/db');

const { runBackfill } = require(
  path.join(__dirname, '..', '..', 'jobs', 'comp-letter-backfill', 'dist', 'backfill.cjs')
);

const SOURCE = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PROBE = 'comp_letter_backfill_probe';
const ROCK = 11;
const SOUNDTRACKS = 12;
const OTHER_GENRE = 7; // Jazz: a V/A slot here is never a candidate
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

describe('comp-letter backfill (real PG)', () => {
  let sql;
  const lines = [];
  const log = (line) => lines.push(line);

  const seedSlot = async (name, genreId, { code = 0, codeLetters = 'V/A', letter = null } = {}) => {
    const [artist] = await sql`
      INSERT INTO ${sql(PROBE)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${name}, ${name}, ${codeLetters})
      RETURNING id
    `;
    await sql`
      INSERT INTO ${sql(PROBE)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code, code_comp_letter)
      VALUES (${artist.id}, ${genreId}, ${code}, ${letter})
    `;
    return artist.id;
  };

  /** The production shelf: 26 Rock and 26 Soundtracks sections, plus slots that must never be lettered. */
  const seedShelf = async ({ skip = [] } = {}) => {
    for (const l of ALPHABET) {
      if (!skip.includes(`Rock ${l}`)) await seedSlot(`Various Artists - Rock - ${l}`, ROCK);
      if (!skip.includes(`Soundtracks ${l}`)) await seedSlot(`Soundtracks - ${l}`, SOUNDTRACKS);
    }
    await seedSlot('Various Artists', SOUNDTRACKS); // the catch-all's Soundtracks filing: reported, not lettered
    await seedSlot('Various Artists - Jazz - B', OTHER_GENRE); // wrong genre
    await seedSlot('Clinic - A', ROCK, { code: 14, codeLetters: 'CL' }); // a named artist whose name ends " - A"
  };

  const letters = () => sql`
    SELECT g.genre_name, gac.code_comp_letter AS letter, a.artist_name
      FROM ${sql(PROBE)}.genre_artist_crossreference gac
      JOIN ${sql(PROBE)}.artists a ON a.id = gac.artist_id
      JOIN ${sql(PROBE)}.genres g ON g.id = gac.genre_id
     WHERE gac.code_comp_letter IS NOT NULL
     ORDER BY g.genre_name, gac.code_comp_letter
  `;

  beforeAll(() => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    lines.length = 0;
    await sql`DROP SCHEMA IF EXISTS ${sql(PROBE)} CASCADE`;
    await sql`CREATE SCHEMA ${sql(PROBE)}`;
    for (const table of ['genres', 'artists', 'genre_artist_crossreference', 'library']) {
      await sql`CREATE TABLE ${sql(PROBE)}.${sql(table)} (LIKE ${sql(SOURCE)}.${sql(table)} INCLUDING ALL)`;
    }
    await sql`INSERT INTO ${sql(PROBE)}.genres (id, genre_name) VALUES (${ROCK}, 'Rock'), (${SOUNDTRACKS}, 'Soundtracks'), (${OTHER_GENRE}, 'Jazz')`;
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(PROBE)} CASCADE`;
  });

  test('--apply letters exactly the 52 sections and nothing else', async () => {
    await seedShelf();

    const result = await runBackfill(sql, { schema: PROBE, apply: true, log });

    expect(result.status).toBe('applied');
    const rows = await letters();
    expect(rows).toHaveLength(52);
    for (const genre of ['Rock', 'Soundtracks']) {
      expect(rows.filter((r) => r.genre_name === genre).map((r) => r.letter)).toEqual(ALPHABET);
    }
    for (const row of rows) expect(row.artist_name.endsWith(` - ${row.letter}`)).toBe(true);
    expect(lines.join('\n')).toMatch(/not lettered: 1\n\s+Soundtracks\s+\d+\s+Various Artists$/m);
  });

  test('a dry run reports the 52 and writes nothing', async () => {
    await seedShelf();

    const result = await runBackfill(sql, { schema: PROBE, apply: false, log });

    expect(result.status).toBe('dry-run');
    expect(await letters()).toEqual([]);
    expect(lines.join('\n')).toMatch(/Rock\s+L\s+\d+\s+Various Artists - Rock - L/);
  });

  test.each([
    ['51 rows (a missing letter)', async () => seedShelf({ skip: ['Rock Q'] })],
    [
      'a duplicate letter',
      async () => {
        await seedShelf({ skip: ['Soundtracks Q'] });
        await seedSlot('Soundtracks - Reissues - P', SOUNDTRACKS); // a second section whose name ends " - P"
      },
    ],
    [
      'a pre-set value',
      async () => {
        await seedShelf({ skip: ['Rock M'] });
        await seedSlot('Various Artists - Rock - M', ROCK, { letter: 'M' });
      },
    ],
  ])('aborts on %s and writes nothing, even with --apply', async (_label, seed) => {
    await seed();
    const before = await letters();

    const result = await runBackfill(sql, { schema: PROBE, apply: true, log });

    expect(result.status).toBe('aborted');
    expect(result.failures.length).toBeGreaterThan(0);
    expect(await letters()).toEqual(before);
  });

  test('a re-run after a successful apply is a no-op', async () => {
    await seedShelf();
    await runBackfill(sql, { schema: PROBE, apply: true, log });
    const after = await letters();

    const rerun = await runBackfill(sql, { schema: PROBE, apply: true, log });

    expect(rerun.status).toBe('already-applied');
    expect(await letters()).toEqual(after);
  });
});
