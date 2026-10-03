/**
 * BS#2775 bio fill — the cohort predicate and the fill-null write, against the
 * live `album_metadata` table.
 *
 * Runs the REAL compiled statements (`jobs/album-metadata-bio-fill/dist/cohort.cjs`)
 * through `@wxyc/database`'s postgres-js driver, the
 * `station-signup-review.spec.js` pattern. The unit suite mocks `drizzle-orm`
 * wholesale, so there a statement is only ever asserted as text; these are the
 * claims that need a real planner:
 *
 *   1. The predicate selects a row with a Discogs match and no bio, and is not
 *      fooled by the `''` synthetic-match sentinel in `discogs_url`.
 *   2. The enumeration returns the artist name the catalog export would, skips
 *      what it should, and honours the cursor and the cap. Given an id list
 *      (BS#2786) it returns only those ids, under the same conditions.
 *   3. The write is fill-null, touches two columns and `updated_at`, and is a
 *      no-op on any row that is not in the cohort at write time.
 *
 * `dist/cohort.cjs` is produced by the workspace build (tsup esm+cjs); CI's
 * Build step runs before the integration tier. Rebuild after editing
 * `cohort.ts` (`npm run build --workspace=@wxyc/album-metadata-bio-fill`).
 *
 * @see WXYC/Backend-Service#2775
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock is auto-applied
// to every `drizzle-orm` require. The compiled bundle needs the real one.
// Hoisted above the requires by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'album-metadata-bio-fill', 'dist');
// The REAL compiled statements -- no reimplementation, so the behaviour under
// test is the behaviour that ships.
const { applyBioFill, enumerateCohort } = require(path.join(distDir, 'cohort.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const ARTWORK = 'https://i.discogs.com/b2775/cover.jpg';
const DISCOGS = 'https://www.discogs.com/release/2775';
const BIO = 'Argentine singer, songwriter and actress.';
const WIKI = 'https://en.wikipedia.org/wiki/Juana_Molina';
const FILL = { artist_bio: BIO, artist_wikipedia_url: WIKI };

describe('BS#2775 bio fill (REAL statements, real PG)', () => {
  let sql;
  const albumIds = [];

  /**
   * A library album plus its `album_metadata` row. `library.artist_name`
   * defaults to a value that differs from the fixture artist's own name, so
   * the enumeration's COALESCE order is observable.
   */
  const seed = async (suffix, metadata = {}, library = {}) => {
    const lib = { artist_name: 'Juana Molina (library)', discogs_unavailable: false, ...library };
    const [{ id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (artist_id, genre_id, format_id, album_title, code_number, artist_name, discogs_unavailable)
      VALUES
        (1, 11, 1, ${'b2775-bio-fill-' + suffix}, 9999, ${lib.artist_name}, ${lib.discogs_unavailable})
      RETURNING id
    `;
    albumIds.push(id);
    const row = {
      artwork_url: ARTWORK,
      discogs_url: DISCOGS,
      artist_bio: null,
      artist_wikipedia_url: null,
      ...metadata,
    };
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, discogs_url, artist_bio, artist_wikipedia_url, spotify_url, release_year, updated_at)
      VALUES
        (${id}, ${row.artwork_url}, ${row.discogs_url}, ${row.artist_bio}, ${row.artist_wikipedia_url},
         'https://open.spotify.com/album/b2775', 2013, NOW() - INTERVAL '1 day')
    `;
    return id;
  };

  const read = async (albumId) => {
    const rows = await sql`
      SELECT artwork_url, discogs_url, release_year, spotify_url, artist_bio, artist_wikipedia_url,
             (updated_at > NOW() - INTERVAL '1 hour') AS touched
        FROM ${sql(SCHEMA)}.album_metadata
       WHERE album_id = ${albumId}
    `;
    return rows[0];
  };

  /** This spec's own rows out of the enumeration, which reads the whole table. */
  const enumerateOwn = async (limit = 0, after = 0) =>
    (await enumerateCohort({ limit, afterAlbumId: after })).filter((c) => albumIds.includes(c.album_id));

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (albumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${albumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${albumIds})`;
    }
    // The pool is shared with the rest of the integration suite; do NOT close it.
  });

  describe('enumeration', () => {
    test('returns a bio-less Discogs-matched row with its card id and the library artist name', async () => {
      const id = await seed('enumerated');

      const [candidate] = (await enumerateOwn()).filter((c) => c.album_id === id);

      expect(candidate.artist_name).toBe('Juana Molina (library)');
      expect(candidate.album_title).toBe('b2775-bio-fill-enumerated');
      const [{ legacy_release_id }] = await sql`SELECT legacy_release_id FROM ${sql(SCHEMA)}.library WHERE id = ${id}`;
      expect(candidate.legacy_release_id).toBe(legacy_release_id);
    });

    test('falls back to artists.artist_name when the library row has none', async () => {
      const id = await seed('artists-fallback', {}, { artist_name: null });
      const [{ artist_name }] = await sql`SELECT artist_name FROM ${sql(SCHEMA)}.artists WHERE id = 1`;

      const [candidate] = (await enumerateOwn()).filter((c) => c.album_id === id);

      expect(candidate.artist_name).toBe(artist_name);
    });

    test.each([
      ['a row that already has a bio', { artist_bio: 'Already here.' }, {}],
      ["the '' synthetic-match sentinel in discogs_url", { discogs_url: '' }, {}],
      ['a row with no Discogs URL', { discogs_url: null }, {}],
      ['an album marked not on Discogs', {}, { discogs_unavailable: true }],
    ])('skips %s', async (_label, metadata, library) => {
      const id = await seed('skipped-' + albumIds.length, metadata, library);

      expect((await enumerateOwn()).map((c) => c.album_id)).not.toContain(id);
    });

    test('honours the cursor and the cap, in album_id order', async () => {
      const first = await seed('cursor-a');
      const second = await seed('cursor-b');

      const afterFirst = (await enumerateOwn(0, first)).map((c) => c.album_id);
      expect(afterFirst).not.toContain(first);
      expect(afterFirst).toContain(second);

      const capped = await enumerateCohort({ limit: 1, afterAlbumId: first - 1 });
      expect(capped.map((c) => c.album_id)).toEqual([first]);
    });

    describe('with an id list (BS#2786)', () => {
      const enumerateIds = async (ids, limit = 0) =>
        (await enumerateCohort({ limit, afterAlbumId: 0, albumIds: ids })).map((c) => c.album_id);

      test('returns only the listed ids, in album_id order, whatever order they were given in', async () => {
        const first = await seed('listed-a');
        const unlisted = await seed('listed-unlisted');
        const last = await seed('listed-b');

        // No `enumerateOwn` filter: the list is the whole result, in a table
        // that holds every other test's rows too.
        expect(await enumerateIds([last, first])).toEqual([first, last]);
        expect(await enumerateIds([unlisted])).toEqual([unlisted]);
      });

      test('gives a listed id no exemption from the cohort predicate or the eligibility conditions', async () => {
        const eligible = await seed('listed-eligible');
        const hasBio = await seed('listed-has-bio', { artist_bio: 'Already here.' });
        const sentinel = await seed('listed-sentinel', { discogs_url: '' });
        const unavailable = await seed('listed-unavailable', {}, { discogs_unavailable: true });
        // An id no library row has: the largest value an `integer` holds.
        const absent = 2147483647;

        expect(await enumerateIds([eligible, hasBio, sentinel, unavailable, absent])).toEqual([eligible]);
      });

      test('drops a listed id once its bio is filled, so a retry cannot re-ask a settled row', async () => {
        const id = await seed('listed-then-filled');
        expect(await enumerateIds([id])).toEqual([id]);

        await applyBioFill(id, FILL);

        expect(await enumerateIds([id])).toEqual([]);
      });

      test('still applies the cap', async () => {
        const first = await seed('listed-cap-a');
        const second = await seed('listed-cap-b');

        expect(await enumerateIds([first, second], 1)).toEqual([first]);
      });

      test('with a cursor, returns the carried ids first, then every row above the cursor, and nothing between', async () => {
        const carried = await seed('carried');
        const between = await seed('carried-between');
        const cursor = await seed('carried-cursor');
        const above = await seed('carried-above');

        const rows = await enumerateCohort({ limit: 2, afterAlbumId: cursor, albumIds: [carried] });

        // `above` is the newest seed, so it is the lowest id past the cursor in
        // a table that holds every other test's rows.
        expect(rows.map((c) => c.album_id)).toEqual([carried, above]);
        expect(rows.map((c) => c.album_id)).not.toContain(between);
      });
    });
  });

  describe('applyBioFill', () => {
    test('writes the bio and the Wikipedia URL, and leaves every other column alone', async () => {
      const id = await seed('fills');

      expect(await applyBioFill(id, FILL)).toBe(true);

      expect(await read(id)).toEqual({
        artwork_url: ARTWORK,
        discogs_url: DISCOGS,
        release_year: 2013,
        spotify_url: 'https://open.spotify.com/album/b2775',
        artist_bio: BIO,
        artist_wikipedia_url: WIKI,
        touched: true,
      });
    });

    test('a second run over a filled row is a no-op: the row has left the cohort', async () => {
      const id = await seed('idempotent');
      await applyBioFill(id, FILL);
      await sql`UPDATE ${sql(SCHEMA)}.album_metadata SET updated_at = NOW() - INTERVAL '1 day' WHERE album_id = ${id}`;

      expect(await applyBioFill(id, { artist_bio: 'A different bio.', artist_wikipedia_url: null })).toBe(false);

      expect(await read(id)).toMatchObject({ artist_bio: BIO, artist_wikipedia_url: WIKI, touched: false });
    });

    test('keeps an existing Wikipedia URL while filling the bio beside it', async () => {
      const existing = 'https://en.wikipedia.org/wiki/Existing';
      const id = await seed('keeps-wiki', { artist_wikipedia_url: existing });

      expect(await applyBioFill(id, FILL)).toBe(true);

      expect(await read(id)).toMatchObject({ artist_bio: BIO, artist_wikipedia_url: existing });
    });

    test('fills the bio alone when there is no Wikipedia URL to write', async () => {
      const id = await seed('bio-only');

      expect(await applyBioFill(id, { artist_bio: BIO, artist_wikipedia_url: null })).toBe(true);

      expect(await read(id)).toMatchObject({ artist_bio: BIO, artist_wikipedia_url: null });
    });

    test('TOCTOU: a row that got a bio between enumeration and write is left untouched', async () => {
      const id = await seed('raced');
      // The live enrichment worker lands first.
      await sql`
        UPDATE ${sql(SCHEMA)}.album_metadata
           SET artist_bio = 'Written by the worker.', updated_at = NOW() - INTERVAL '1 day'
         WHERE album_id = ${id}
      `;

      expect(await applyBioFill(id, FILL)).toBe(false);

      expect(await read(id)).toMatchObject({
        artist_bio: 'Written by the worker.',
        artist_wikipedia_url: null,
        touched: false,
      });
    });

    test.each([
      ["the '' synthetic-match sentinel", { discogs_url: '' }],
      ['a row with no Discogs URL', { discogs_url: null }],
    ])('refuses %s even when asked directly', async (_label, metadata) => {
      const id = await seed('refused-' + albumIds.length, metadata);

      expect(await applyBioFill(id, FILL)).toBe(false);

      expect(await read(id)).toMatchObject({ artist_bio: null, artist_wikipedia_url: null, touched: false });
    });

    test('stores a bio with quotes, a backslash and non-ASCII text verbatim', async () => {
      const awkward = `Nilüfer Yanya's "debut"; C:\\music — 赤痢.`;
      const id = await seed('awkward-text');

      await applyBioFill(id, { artist_bio: awkward, artist_wikipedia_url: null });

      expect((await read(id)).artist_bio).toBe(awkward);
    });
  });
});
