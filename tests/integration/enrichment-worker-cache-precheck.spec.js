/**
 * Integration test for the enrichment worker's cache-first pre-check
 * (B1 / BS#1747, under Epic C #877).
 *
 * B1 reads `album_metadata` for a linked flowsheet row's album BEFORE calling
 * LML and skips the call only when a load-bearing field (`artwork_url` /
 * `discogs_url`) is already non-null. This spec validates the exact SQL
 * predicate that decision keys on, against the live `album_metadata` table
 * (FK to `library`, PK on `album_id`, the real column NULLability).
 *
 * The regression this locks down is BS#1089 negative-cache poisoning: the
 * no-match arm of `enrich.ts` writes an `album_metadata` row carrying ONLY
 * the four synthesized search URLs and leaves `artwork_url` / `discogs_url`
 * NULL. A naive "skip if any row exists" would freeze that false no-match
 * forever. The predicate under test MUST return false for such a shell (and
 * for an all-null row, and for a missing row) so the worker re-calls LML and
 * the row self-heals — and true ONLY when a real, persisted match is present.
 *
 * Pure SQL — does NOT import `apps/enrichment-worker/precheck.ts`. The
 * integration runner is babel-jest with no TS support (drizzle-orm + ts-jest
 * incompatibility; see `enrichment-worker-claim.spec.js` and
 * `album-metadata-upsert.spec.js` headers). The `hasLoadBearingMetadata`
 * helper is the shared canonical mirror of the TS SELECT in
 * `tests/utils/enrichment-precheck.js`; when `precheck.ts` is hand-edited
 * that helper must follow. Division of responsibility:
 *   - Unit (tests/unit/apps/enrichment-worker/cache-precheck.test.ts):
 *     the handler honors the pre-check verdict — skip vs. re-call LML.
 *   - Integration (this file): the SQL predicate's verdict for each real
 *     album_metadata shape.
 *
 * @see WXYC/Backend-Service#1747
 * @see WXYC/Backend-Service#1089
 */

const { getTestDb } = require('../utils/db');
const { hasLoadBearingMetadata } = require('../utils/enrichment-precheck');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Insert a fresh library album to act as the album_metadata FK target.
 * Mirrors `album-metadata-upsert.spec.js#insertLibraryAlbum`: the seeded
 * fixture guarantees artist_id 1, genre_id 11, format_id 1 exist. Returns the
 * new id.
 */
async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'b1-precheck-test-album-' + suffix}, 9999, 'Stereolab')
    RETURNING id
  `;
  return rows[0].id;
}

describe('enrichment-worker cache-first pre-check predicate (real PG)', () => {
  let sql;
  /** album_ids inserted; deleted in afterAll regardless of pass/fail. */
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      // album_metadata FK cascades on delete from library; delete it first
      // explicitly in case the FK is ever loosened.
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('SKIP: non-null artwork_url is load-bearing → true', async () => {
    const albumId = await insertLibraryAlbum(sql, 'artwork');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('SKIP: non-null discogs_url is load-bearing → true', async () => {
    const albumId = await insertLibraryAlbum(sql, 'discogs');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, discogs_url, updated_at)
      VALUES (${albumId}, 'https://www.discogs.com/release/12345', NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('SELF-HEAL: missing album_metadata row → false (worker calls LML)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'missing');
    insertedAlbumIds.push(albumId);
    // No album_metadata row inserted.

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SELF-HEAL: all-null-load-bearing row → false (worker calls LML)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'all-null');
    insertedAlbumIds.push(albumId);
    // Row exists but both load-bearing columns are NULL (e.g. a row that only
    // ever recorded release_year, or a torn write).
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, release_year, updated_at)
      VALUES (${albumId}, 2022, NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SELF-HEAL (BS#1089 guard): search-URL-only shell → false (worker calls LML)', async () => {
    // The exact shape enrich.ts's linked no-match arm writes: the four
    // synthesized search URLs, both load-bearing columns NULL. This is the
    // poisoned no-match that must NOT be frozen — the predicate returns false
    // so the worker re-calls LML and the row self-heals.
    const albumId = await insertLibraryAlbum(sql, 'search-shell');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, spotify_url, youtube_music_url, bandcamp_url, soundcloud_url, updated_at)
      VALUES
        (${albumId},
         'https://open.spotify.com/search/Stereolab%20Aluminum%20Tunes',
         'https://music.youtube.com/search?q=Stereolab%20Aluminum%20Tunes',
         'https://bandcamp.com/search?q=Stereolab%20Aluminum%20Tunes',
         'https://soundcloud.com/search?q=Stereolab%20Aluminum%20Tunes',
         NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SKIP: a shell later healed to carry artwork_url flips false → true', async () => {
    // End-to-end of the self-heal contract at the predicate layer: a poisoned
    // search-URL-only shell reads false (re-call), then once LML resolves a
    // real match and the load-bearing column is populated, the predicate
    // reads true (subsequent plays skip). No frozen false no-match.
    const albumId = await insertLibraryAlbum(sql, 'heal-flip');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, spotify_url, updated_at)
      VALUES (${albumId}, 'https://open.spotify.com/search/Stereolab', NOW())
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);

    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET artwork_url = 'https://i.discogs.com/b1/healed.jpg', updated_at = NOW()
       WHERE album_id = ${albumId}
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });
});
