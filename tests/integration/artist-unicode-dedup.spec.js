/**
 * Integration tests for the Unicode-form artist matcher + dedup (BS#1897).
 *
 * Validates against a REAL Postgres (migration 0134's `fold_artist_name`
 * function + `artists_fold_name_idx`):
 *   1. `fold_artist_name` collapses NFC / NFD / ASCII-fold / case onto one key
 *      and keeps genuinely-distinct names distinct.
 *   2. The `artistIdFromName` matcher query (the catalog write-boundary lookup
 *      behind `POST /library`) resolves NFC / NFD / ASCII-fold inputs of a
 *      seeded artist to that single row, and returns nothing for a distinct
 *      name (no false-merge).
 *   3. The dedup merge repoints `library.artist_id` +
 *      `genre_artist_crossreference.artist_id` to the survivor, deletes the
 *      duplicate `artists` row, NFC-normalizes the survivor, and is idempotent.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). The merge SQL here mirrors `mergeGroup` +
 * `findDuplicateGroups` in `jobs/artist-unicode-dedup/job.ts` and the matcher
 * query mirrors `artistIdFromName` in `apps/backend/services/library.service.ts`;
 * when either is hand-edited, the SQL here must follow.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Genre + format ids that exist in the integration fixture (used across
// library.spec.js POST /library tests).
const GENRE_ID = 11;
const FORMAT_ID = 1;

// NFC vs NFD spellings of the same names, from explicit codepoints.
const NILUFER_NFC = 'ZZDEDUP Nilüfer'; // ü = U+00FC
const NILUFER_NFD = 'ZZDEDUP Nilüfer'; // u + U+0308
const NILUFER_ASCII = 'ZZDEDUP Nilufer';

async function insertArtist(sql, name, codeLetters) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
    VALUES (${name}, ${name}, ${codeLetters})
    RETURNING id
  `;
  return rows[0].id;
}

async function insertGenreCrossref(sql, artistId, genreCode) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
    VALUES (${artistId}, ${GENRE_ID}, ${genreCode})
  `;
}

async function insertLibraryRow(sql, artistId, title, codeNumber) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
    VALUES (${artistId}, ${GENRE_ID}, ${FORMAT_ID}, ${title}, ${codeNumber})
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Mirror of `artistIdFromName` (apps/backend/services/library.service.ts): fold
 * both sides, scoped to the genre join.
 */
async function matchArtistId(sql, name, genreId) {
  const rows = await sql`
    SELECT a.id
    FROM ${sql(SCHEMA)}.artists a
    JOIN ${sql(SCHEMA)}.genre_artist_crossreference g ON g.artist_id = a.id
    WHERE ${sql(SCHEMA)}.fold_artist_name(a.artist_name) = ${sql(SCHEMA)}.fold_artist_name(${name})
      AND g.genre_id = ${genreId}
    LIMIT 1
  `;
  return rows.length ? rows[0].id : 0;
}

/**
 * Mirror of `mergeGroup` for the two FK sites this test seeds. Full job covers
 * all 11 `artist_id` FK sites; see jobs/artist-unicode-dedup/job.ts.
 */
async function mergeInto(sql, survivorId, dupId) {
  await sql.begin(async (tx) => {
    // genre_artist_crossreference: unique (artist_id, genre_id) — drop dup rows
    // that would collide with an existing survivor row, then repoint the rest.
    await tx`
      DELETE FROM ${tx(SCHEMA)}.genre_artist_crossreference d
       WHERE d.artist_id = ${dupId}
         AND EXISTS (SELECT 1 FROM ${tx(SCHEMA)}.genre_artist_crossreference k
                     WHERE k.artist_id = ${survivorId} AND k.genre_id = d.genre_id)
    `;
    await tx`UPDATE ${tx(SCHEMA)}.genre_artist_crossreference SET artist_id = ${survivorId} WHERE artist_id = ${dupId}`;
    // library: no uniqueness on artist_id — plain repoint.
    await tx`UPDATE ${tx(SCHEMA)}.library SET artist_id = ${survivorId} WHERE artist_id = ${dupId}`;
    // delete the duplicate (all FKs now repointed).
    await tx`DELETE FROM ${tx(SCHEMA)}.artists WHERE id = ${dupId}`;
    // NFC-normalize the survivor.
    await tx`
      UPDATE ${tx(SCHEMA)}.artists
         SET artist_name = normalize(artist_name, NFC)
       WHERE id = ${survivorId} AND artist_name IS DISTINCT FROM normalize(artist_name, NFC)
    `;
  });
}

describe('Unicode-form artist matcher + dedup (real PG, BS#1897)', () => {
  let sql;
  const artistIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    for (const id of artistIds) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE artist_id = ${id}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id = ${id}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${id}`;
    }
  });

  describe('fold_artist_name SQL function', () => {
    test('folds NFC / NFD / ASCII-fold / case to one key', async () => {
      const rows = await sql`
        SELECT
          ${sql(SCHEMA)}.fold_artist_name(${NILUFER_NFC})   AS nfc,
          ${sql(SCHEMA)}.fold_artist_name(${NILUFER_NFD})   AS nfd,
          ${sql(SCHEMA)}.fold_artist_name(${NILUFER_ASCII}) AS ascii,
          ${sql(SCHEMA)}.fold_artist_name('ZZDEDUP NILÜFER') AS upper
      `;
      const { nfc, nfd, ascii, upper } = rows[0];
      expect(nfc).toBe('zzdedup nilufer');
      expect(nfd).toBe(nfc);
      expect(ascii).toBe(nfc);
      expect(upper).toBe(nfc);
    });

    test('keeps genuinely-distinct names distinct', async () => {
      const rows = await sql`
        SELECT
          ${sql(SCHEMA)}.fold_artist_name('Stereolab') AS a,
          ${sql(SCHEMA)}.fold_artist_name('Cat Power') AS b
      `;
      expect(rows[0].a).not.toBe(rows[0].b);
    });
  });

  describe('artistIdFromName matcher', () => {
    let seededId;

    beforeAll(async () => {
      // Seed one artist stored NFC, in GENRE_ID.
      seededId = await insertArtist(sql, NILUFER_NFC, 'ZDN');
      artistIds.push(seededId);
      await insertGenreCrossref(sql, seededId, 90001);
    });

    test('matches the NFC-stored artist from an NFD input', async () => {
      expect(await matchArtistId(sql, NILUFER_NFD, GENRE_ID)).toBe(seededId);
    });

    test('matches the NFC-stored artist from an ASCII-fold input', async () => {
      expect(await matchArtistId(sql, NILUFER_ASCII, GENRE_ID)).toBe(seededId);
    });

    test('matches the NFC input itself', async () => {
      expect(await matchArtistId(sql, NILUFER_NFC, GENRE_ID)).toBe(seededId);
    });

    test('does NOT match a genuinely-different name (no false-merge)', async () => {
      expect(await matchArtistId(sql, 'ZZDEDUP Jessica Pratt', GENRE_ID)).toBe(0);
    });

    test('does NOT match in a different genre (genre scoping preserved)', async () => {
      expect(await matchArtistId(sql, NILUFER_NFD, GENRE_ID + 1)).toBe(0);
    });
  });

  describe('dedup merge', () => {
    test('merges an NFC/NFD form-duplicate: repoints FKs, deletes dup, NFC survivor, idempotent', async () => {
      // Survivor = lower id (inserted first, NFC). Duplicate = NFD.
      const survivorId = await insertArtist(sql, NILUFER_NFC, 'ZD1');
      const dupId = await insertArtist(sql, NILUFER_NFD, 'ZD2');
      artistIds.push(survivorId, dupId);
      expect(dupId).toBeGreaterThan(survivorId);

      await insertGenreCrossref(sql, survivorId, 90010);
      await insertGenreCrossref(sql, dupId, 90011);
      const survLib = await insertLibraryRow(sql, survivorId, 'ZZDEDUP Album A', 1);
      const dupLib = await insertLibraryRow(sql, dupId, 'ZZDEDUP Album B', 1);

      // Confirm the fold groups them together.
      const grouped = await sql`
        SELECT array_agg(id ORDER BY id) AS ids
        FROM ${sql(SCHEMA)}.artists
        WHERE id IN (${survivorId}, ${dupId})
        GROUP BY ${sql(SCHEMA)}.fold_artist_name(artist_name)
      `;
      expect(grouped).toHaveLength(1);
      expect(grouped[0].ids.map(Number)).toEqual([survivorId, dupId]);

      await mergeInto(sql, survivorId, dupId);

      // Duplicate artist row is gone; survivor remains.
      const remaining = await sql`
        SELECT id, artist_name FROM ${sql(SCHEMA)}.artists WHERE id IN (${survivorId}, ${dupId})
      `;
      expect(remaining.map((r) => Number(r.id))).toEqual([survivorId]);
      // Survivor stored NFC (round-trips through normalize unchanged).
      expect(remaining[0].artist_name).toBe(NILUFER_NFC);

      // Both library rows now point at the survivor.
      const libArtists = await sql`
        SELECT artist_id FROM ${sql(SCHEMA)}.library WHERE id IN (${survLib}, ${dupLib}) ORDER BY id
      `;
      expect(libArtists.map((r) => Number(r.artist_id))).toEqual([survivorId, survivorId]);

      // genre_artist_crossreference collapsed to the survivor's single (artist, genre) row.
      const crossrefs = await sql`
        SELECT artist_id FROM ${sql(SCHEMA)}.genre_artist_crossreference
        WHERE artist_id IN (${survivorId}, ${dupId})
      `;
      expect(crossrefs.map((r) => Number(r.artist_id))).toEqual([survivorId]);

      // Idempotent: the dup id no longer exists, so a re-merge is a no-op that
      // affects zero rows (and does not resurrect the group).
      await mergeInto(sql, survivorId, dupId);
      const afterReRun = await sql`
        SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.artists WHERE id = ${survivorId}
      `;
      expect(afterReRun[0].n).toBe(1);
    });
  });
});
