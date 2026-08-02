/**
 * Integration tests for library-etl's Unicode-form artist matcher (BS#1095).
 *
 * `jobs/library-etl/job.ts`'s `ensureArtist` (both branches) and
 * `findArtistId` matched existing `artists` rows via
 * `lower(artist_name) = lower($name)`, which is collation-aware but NOT
 * Unicode-form aware: 'Nilüfer Yanya' in NFC ('ü' = U+00FC) vs NFD ('u' +
 * U+0308) is byte-distinct and misses, so the ETL inserted a duplicate
 * `artists` row per composition form. The fix swaps both predicates to
 * `fold_artist_name(artist_name) = fold_artist_name($name)` (migration 0134),
 * mirroring the BS#1897 runtime-path fix already pinned against real Postgres
 * in `artist-unicode-dedup.spec.js` (the `artistIdFromName` matcher there has
 * the exact same shape as this file's genre-agnostic branch).
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). The queries here mirror `ensureArtist`'s two branches
 * and `findArtistId` in `jobs/library-etl/job.ts`; when any of those is
 * hand-edited, the SQL here must follow.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Genre id that exists in the integration fixture (used across
// library.spec.js POST /library tests and artist-unicode-dedup.spec.js).
const GENRE_ID = 11;

// NFC vs NFD spellings of the same name, from explicit codepoints.
const NILUFER_NFC = 'ZZ1095 Nilüfer'; // ü = U+00FC
const NILUFER_NFD = 'ZZ1095 Nilüfer'; // u + U+0308
const NILUFER_ASCII = 'ZZ1095 Nilufer';

async function insertArtist(sql, name, codeLetters) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
    VALUES (${name}, ${name}, ${codeLetters})
    RETURNING id
  `;
  return rows[0].id;
}

async function insertGenreCrossref(sql, artistId, genreId, artistGenreCode) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
    VALUES (${artistId}, ${genreId}, ${artistGenreCode})
  `;
}

/**
 * Mirror of `ensureArtist`'s various-artist branch (name + code_letters, no
 * genre scoping) and `findArtistId` — both use this exact predicate shape.
 */
async function matchByNameAndCodeLetters(sql, name, codeLetters) {
  const rows = await sql`
    SELECT a.id
    FROM ${sql(SCHEMA)}.artists a
    WHERE ${sql(SCHEMA)}.fold_artist_name(a.artist_name) = ${sql(SCHEMA)}.fold_artist_name(${name})
      AND lower(a.code_letters) = lower(${codeLetters})
    LIMIT 1
  `;
  return rows.length ? rows[0].id : 0;
}

/**
 * Mirror of `ensureArtist`'s non-various (genre-scoped) match branch.
 */
async function matchEnsureArtistGenreScoped(sql, name, codeLetters, genreId, artistGenreCode) {
  const rows = await sql`
    SELECT a.id
    FROM ${sql(SCHEMA)}.artists a
    JOIN ${sql(SCHEMA)}.genre_artist_crossreference g ON g.artist_id = a.id
    WHERE ${sql(SCHEMA)}.fold_artist_name(a.artist_name) = ${sql(SCHEMA)}.fold_artist_name(${name})
      AND lower(a.code_letters) = lower(${codeLetters})
      AND g.genre_id = ${genreId}
      AND g.artist_genre_code = ${artistGenreCode}
    LIMIT 1
  `;
  return rows.length ? rows[0].id : 0;
}

describe('library-etl artist Unicode-form fold match (real PG, BS#1095)', () => {
  let sql;
  const artistIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    for (const id of artistIds) {
      await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id = ${id}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${id}`;
    }
  });

  describe('various-artist branch / findArtistId shape (name + code_letters only)', () => {
    let seededId;

    beforeAll(async () => {
      seededId = await insertArtist(sql, NILUFER_NFC, 'ZN');
      artistIds.push(seededId);
    });

    test('matches the NFC-stored artist from an NFD input', async () => {
      expect(await matchByNameAndCodeLetters(sql, NILUFER_NFD, 'ZN')).toBe(seededId);
    });

    test('matches the NFC-stored artist from an ASCII-fold input', async () => {
      expect(await matchByNameAndCodeLetters(sql, NILUFER_ASCII, 'ZN')).toBe(seededId);
    });

    test('matches the NFC input itself', async () => {
      expect(await matchByNameAndCodeLetters(sql, NILUFER_NFC, 'ZN')).toBe(seededId);
    });

    test('does NOT match a genuinely-different name (no false-merge)', async () => {
      expect(await matchByNameAndCodeLetters(sql, 'ZZ1095 Jessica Pratt', 'ZN')).toBe(0);
    });

    test('does NOT match with different code_letters (scoping preserved)', async () => {
      expect(await matchByNameAndCodeLetters(sql, NILUFER_NFD, 'XX')).toBe(0);
    });
  });

  describe('ensureArtist genre-scoped branch', () => {
    let seededId;
    const artistGenreCode = 90021;

    beforeAll(async () => {
      seededId = await insertArtist(sql, NILUFER_NFC, 'ZG');
      artistIds.push(seededId);
      await insertGenreCrossref(sql, seededId, GENRE_ID, artistGenreCode);
    });

    test('matches the NFC-stored artist from an NFD input, scoped by genre + artist_genre_code', async () => {
      expect(await matchEnsureArtistGenreScoped(sql, NILUFER_NFD, 'ZG', GENRE_ID, artistGenreCode)).toBe(seededId);
    });

    test('matches the NFC input itself', async () => {
      expect(await matchEnsureArtistGenreScoped(sql, NILUFER_NFC, 'ZG', GENRE_ID, artistGenreCode)).toBe(seededId);
    });

    test('does NOT match in a different genre (genre scoping preserved)', async () => {
      expect(await matchEnsureArtistGenreScoped(sql, NILUFER_NFD, 'ZG', GENRE_ID + 1, artistGenreCode)).toBe(0);
    });

    test('does NOT match with a different artist_genre_code (scoping preserved)', async () => {
      expect(await matchEnsureArtistGenreScoped(sql, NILUFER_NFD, 'ZG', GENRE_ID, artistGenreCode + 1)).toBe(0);
    });
  });
});
