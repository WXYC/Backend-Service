/**
 * Integration tests for diacritic-insensitive artist prefix search (BS#2023).
 *
 * `GET /library/artists/search` (`searchArtistsInGenre`) and
 * `GET /flowsheet/suggest/artists` (`suggestArtists`) used to match
 * `artist_name ILIKE 'q%'`, which is case-insensitive but not diacritic- or
 * Unicode-form-insensitive, so `Nilufer` missed `Nilüfer Yanya`. Both now
 * prefix-match `fold_artist_name(artist_name)` against `fold_artist_name(q)`,
 * both folded by the SQL function the write boundary (`artistIdFromName`,
 * BS#1897) keys on. The query is folded in SQL, not TypeScript, because JS
 * `toLowerCase` applies the Greek final-sigma rule that PG `lower()` does not.
 *
 * Seeds the three diacritic-bearing canonical WXYC names plus a Greek name and
 * asserts both the folded (ASCII) query and the exact-form query reach them. The `%`/`_` escape
 * contract (`escapeLikePattern`, applied by `foldedPrefixLike`) is pinned too: a wildcard in `q` is literal text.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Genre + format ids that exist in the integration fixture (library.spec.js).
const GENRE_ID = 11;
const FORMAT_ID = 1;

// [stored name, folded-ASCII query, exact-form query]
const CANONICAL = [
  ['Nilüfer Yanya', 'Nilufer', 'Nilüfer'],
  ['Csillagrablók', 'Csillagrablok', 'Csillagrablók'],
  ['Hermanos Gutiérrez', 'Hermanos Gutierrez', 'Hermanos Gutiérrez'],
  // Greek final sigma: a query ending in a capital sigma ('ΑΣ') must still match. JS lower-cases it to
  // a final sigma ('ας'), PG lower() to 'σ', so a TypeScript-folded pattern would find nothing.
  ['\u0391\u03c3\u03c4\u03c1\u03bf\u03bd\u03bf\u03bc\u03af\u03b1', '\u0391\u03a3', '\u0391\u03c3\u03c4'],
];

// The same Nilüfer in NFD (`u` + U+0308) -- byte-distinct from the stored NFC.
const NILUFER_NFD_QUERY = 'Nilüfer';

describe('Artist prefix search folds diacritics (BS#2023)', () => {
  let auth;
  const artistIds = [];

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    const sql = getTestDb();
    for (const [i, [name]] of CANONICAL.entries()) {
      const [artist] = await sql`
        INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
        VALUES (${name}, ${name}, 'ZF')
        RETURNING id
      `;
      artistIds.push(artist.id);
      await sql`
        INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
        VALUES (${artist.id}, ${GENRE_ID}, ${9300 + i})
      `;
      // suggestArtists joins `library`, so an artist with no release is invisible to it.
      await sql`
        INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
        VALUES (${artist.id}, ${GENRE_ID}, ${FORMAT_ID}, ${`BS2023 ${name}`}, ${9300 + i})
      `;
    }
  });

  afterAll(async () => {
    const sql = getTestDb();
    if (artistIds.length === 0) {
      return;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE artist_id IN ${sql(artistIds)}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id IN ${sql(artistIds)}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id IN ${sql(artistIds)}`;
  });

  const queryCases = CANONICAL.flatMap(([name, folded, exact]) => [
    [name, 'folded', folded],
    [name, 'exact-form', exact],
    [name, 'upper-case folded', folded.toUpperCase()],
  ]).concat([['Nilüfer Yanya', 'NFD', NILUFER_NFD_QUERY]]);

  describe('GET /library/artists/search', () => {
    test.each(queryCases)('%s is found by its %s query (%s)', async (name, _label, q) => {
      const res = await auth.get('/library/artists/search').query({ q, limit: 20 }).expect(200);

      expect(res.body.artists.map((a) => a.artist_name)).toContain(name);
    });

    test('a LIKE wildcard in q is literal text, not a contains-anything scan', async () => {
      const res = await auth.get('/library/artists/search').query({ q: '%ilufer', limit: 20 }).expect(200);

      expect(res.body.artists).toEqual([]);
    });
  });

  describe('GET /flowsheet/suggest/artists', () => {
    test.each(queryCases)('%s is suggested for its %s query (%s)', async (name, _label, q) => {
      const res = await auth.get('/flowsheet/suggest/artists').query({ q, limit: 20 }).expect(200);

      expect(res.body).toContain(name);
    });

    test('a LIKE wildcard in q is literal text, not a contains-anything scan', async () => {
      const res = await auth.get('/flowsheet/suggest/artists').query({ q: '%ilufer', limit: 20 }).expect(200);

      expect(res.body).toEqual([]);
    });
  });

  describe('query plan', () => {
    test('the folded prefix predicate is served by artists_fold_name_prefix_idx (migration 0195)', async () => {
      const sql = getTestDb();
      // Seqscan is disabled so a tiny CI table cannot hide an unusable index:
      // with the default opclass (artists_fold_name_idx alone) the planner has
      // no index path for LIKE and falls back to a disabled seq scan.
      const plan = await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        // A literal, not a bind parameter, so the planner sees the prefix at plan time.
        const rows = await tx.unsafe(
          `EXPLAIN SELECT id FROM "${SCHEMA}".artists WHERE "${SCHEMA}".fold_artist_name(artist_name) LIKE ("${SCHEMA}".fold_artist_name('Nilufer') || '%') ESCAPE '\\'`
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });

      expect(plan).toContain('artists_fold_name_prefix_idx');
    });
  });
});
