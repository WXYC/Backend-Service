/**
 * Integration test for the album_metadata UPSERT contract used by D3
 * (BS#899 / Epic D).
 *
 * Both runtime writers — `apps/backend/services/metadata/enrichment.service.ts`
 * (in-process) and `apps/enrichment-worker/enrich.ts` (worker) — UPSERT
 * `album_metadata` keyed by `album_id` whenever the flowsheet row is linked
 * to a library album. The unit tests cover the Drizzle builder shape; this
 * spec validates the actual PostgreSQL semantics:
 *
 *   1. INSERT path: new album_id → row materializes with the full 10-column
 *      payload + updated_at.
 *   2. UPDATE-on-conflict path: subsequent UPSERTs against the same album_id
 *      flow through ON CONFLICT DO UPDATE; `updated_at` advances, the
 *      payload overwrites.
 *   3. No-match shape: when only the 3 synthesized search URLs are written,
 *      the 7 other columns stay NULL on INSERT and untouched on UPDATE
 *      (matches the worker's no-match branch + the in-process .then arm's
 *      no-match payload).
 *   4. catch-arm conflict-do-nothing: a search-URL fallback INSERT against
 *      an album_id that already has a fully-enriched row leaves the existing
 *      payload intact (no clobber of artwork_url / discogs_url / etc.).
 *   5. BS#1336 extended columns: the 8 LML-only columns the worker added to
 *      its match payload (discogs_artist_id, label, full_release_date,
 *      genres/styles as `text[]`, tracklist/bio_tokens as `jsonb`,
 *      artist_image_url) round-trip through real PG — arrays come back as JS
 *      arrays, jsonb comes back parsed (the read path spreads/projects them).
 *
 * (Coverage 1-4 above predate BS#1336 and describe the 10-column base
 * payload; the worker's match payload is now 18 columns — see #5.)
 *
 * Pure SQL — does NOT import `apps/enrichment-worker/enrich.ts` or
 * `apps/backend/services/metadata/enrichment.service.ts`. The integration
 * runner is babel-jest with no TS support (see `library-identity-backfill.spec.js`
 * and `enrichment-worker-claim.spec.js` headers for the drizzle-orm + ts-jest
 * incompatibility). Division of responsibility:
 *   - Unit: source-code shape (Drizzle .insert().values().onConflictDoUpdate
 *     payload, race-guard setWhere, race-detector returning behavior).
 *   - Integration (this file): SQL contract against the live `album_metadata`
 *     table (FK to library, PK on album_id, updated_at default).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Issue the worker's full match-branch UPSERT directly. Mirrors
 * `finalizeRow` in `apps/enrichment-worker/enrich.ts` when the LML lookup
 * returned artwork. When that file is hand-edited the SQL here must follow.
 */
async function upsertMatch(sql, albumId, payload) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata
      (album_id, artwork_url, discogs_url, release_year, spotify_url, apple_music_url,
       youtube_music_url, bandcamp_url, soundcloud_url, artist_bio, artist_wikipedia_url,
       updated_at)
    VALUES
      (${albumId}, ${payload.artwork_url}, ${payload.discogs_url}, ${payload.release_year},
       ${payload.spotify_url}, ${payload.apple_music_url}, ${payload.youtube_music_url},
       ${payload.bandcamp_url}, ${payload.soundcloud_url}, ${payload.artist_bio},
       ${payload.artist_wikipedia_url}, NOW())
    ON CONFLICT (album_id) DO UPDATE
       SET artwork_url          = EXCLUDED.artwork_url,
           discogs_url          = EXCLUDED.discogs_url,
           release_year         = EXCLUDED.release_year,
           spotify_url          = EXCLUDED.spotify_url,
           apple_music_url      = EXCLUDED.apple_music_url,
           youtube_music_url    = EXCLUDED.youtube_music_url,
           bandcamp_url         = EXCLUDED.bandcamp_url,
           soundcloud_url       = EXCLUDED.soundcloud_url,
           artist_bio           = EXCLUDED.artist_bio,
           artist_wikipedia_url = EXCLUDED.artist_wikipedia_url,
           updated_at           = NOW()
     WHERE ${sql(SCHEMA)}.album_metadata.updated_at < NOW()
  `;
}

/**
 * BS#1336: the worker's match branch now also writes 8 LML-only columns
 * (discogs_artist_id, label, full_release_date, genres, styles, tracklist,
 * artist_image_url, bio_tokens). This INSERT carries them so the `text[]`
 * (genres/styles) and `jsonb` (tracklist/bio_tokens) types round-trip through
 * real PG + postgres-js — the half the mocked unit tests can't exercise. Kept
 * separate from `upsertMatch` so the 10-column contract tests stay focused;
 * the same `finalizeRow` source governs both. postgres-js binds a JS array as
 * text[] natively; jsonb columns are wrapped with `sql.json()`.
 */
async function upsertMatchExtended(sql, albumId, payload) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata
      (album_id, artwork_url, discogs_url, release_year, spotify_url, apple_music_url,
       youtube_music_url, bandcamp_url, soundcloud_url, artist_bio, artist_wikipedia_url,
       discogs_artist_id, label, full_release_date, genres, styles, tracklist,
       artist_image_url, bio_tokens, updated_at)
    VALUES
      (${albumId}, ${payload.artwork_url}, ${payload.discogs_url}, ${payload.release_year},
       ${payload.spotify_url}, ${payload.apple_music_url}, ${payload.youtube_music_url},
       ${payload.bandcamp_url}, ${payload.soundcloud_url}, ${payload.artist_bio},
       ${payload.artist_wikipedia_url}, ${payload.discogs_artist_id}, ${payload.label},
       ${payload.full_release_date}, ${payload.genres}, ${payload.styles},
       ${sql.json(payload.tracklist)}, ${payload.artist_image_url}, ${sql.json(payload.bio_tokens)},
       NOW())
  `;
}

/**
 * Worker's no-match branch (LML responded but no Discogs match). Writes
 * only the 3 synthesized search URLs; the 7 other fields stay untouched.
 */
async function upsertNoMatch(sql, albumId, searchUrls) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata
      (album_id, youtube_music_url, bandcamp_url, soundcloud_url, updated_at)
    VALUES
      (${albumId}, ${searchUrls.youtube_music_url}, ${searchUrls.bandcamp_url},
       ${searchUrls.soundcloud_url}, NOW())
    ON CONFLICT (album_id) DO UPDATE
       SET youtube_music_url = EXCLUDED.youtube_music_url,
           bandcamp_url      = EXCLUDED.bandcamp_url,
           soundcloud_url    = EXCLUDED.soundcloud_url,
           updated_at        = NOW()
     WHERE ${sql(SCHEMA)}.album_metadata.updated_at < NOW()
  `;
}

/**
 * In-process catch-arm fallback (LML threw). Writes search URLs ONLY when
 * no album_metadata row exists yet — never clobbers a prior successful
 * enrichment. Mirrors `enrichment.service.ts`'s catch path.
 */
async function insertFallbackOnly(sql, albumId, searchUrls) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata
      (album_id, youtube_music_url, bandcamp_url, soundcloud_url, updated_at)
    VALUES
      (${albumId}, ${searchUrls.youtube_music_url}, ${searchUrls.bandcamp_url},
       ${searchUrls.soundcloud_url}, NOW())
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Insert a fresh library album to act as the FK target. Returns the new id.
 * Uses an obviously synthetic title so cleanup is unambiguous.
 */
async function insertLibraryAlbum(sql, suffix) {
  // artist_id, genre_id, format_id are all NOT NULL on `library`. The seeded
  // fixture in dev_env/seed_db.sql guarantees ids 1-3 (artists), 11/6
  // (genres), 1/2 (format) exist. Use those rather than threading the FK
  // resolution through this test.
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'d3-upsert-test-album-' + suffix}, 9999, 'Built to Spill')
    RETURNING id
  `;
  return rows[0].id;
}

const FULL_PAYLOAD = {
  artwork_url: 'https://i.discogs.com/d3-test/cover.jpg',
  discogs_url: 'https://discogs.com/release/999999',
  release_year: 2022,
  spotify_url: 'https://open.spotify.com/album/d3test',
  apple_music_url: 'https://music.apple.com/album/d3test',
  youtube_music_url: 'https://music.youtube.com/playlist/d3test',
  bandcamp_url: 'https://artist.bandcamp.com/album/d3test',
  soundcloud_url: 'https://soundcloud.com/album/d3test',
  artist_bio: 'A D3 test bio.',
  artist_wikipedia_url: 'https://en.wikipedia.org/wiki/D3_test',
};

const SEARCH_URLS = {
  youtube_music_url: 'https://music.youtube.com/search?q=D3%20test',
  bandcamp_url: 'https://bandcamp.com/search?q=D3%20test',
  soundcloud_url: 'https://soundcloud.com/search?q=D3%20test',
};

// BS#1336: 10 base columns + the 8 LML-only columns. Arrays/objects here
// exercise the text[] and jsonb round-trip.
const EXTENDED_PAYLOAD = {
  ...FULL_PAYLOAD,
  discogs_artist_id: 3840,
  label: 'Sonamos',
  full_release_date: '2022-09-30',
  genres: ['Rock', 'Jazz'],
  styles: ['Folk', 'Indie Rock'],
  tracklist: [{ position: '1', title: 'la paradoja', duration: '4:12' }],
  artist_image_url: 'https://i.discogs.com/artist/juana.jpg',
  bio_tokens: [{ type: 'plainText', text: 'Argentine musician' }],
};

describe('album_metadata UPSERT contract (real PG)', () => {
  let sql;
  /** album_ids inserted; deleted in afterAll regardless of pass/fail. */
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      // album_metadata FK cascades on delete; deleting from library cleans
      // both. Belt + suspenders: target album_metadata explicitly first in
      // case the FK was ever loosened.
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  test('INSERT path: new album_id materializes with full 10-column payload', async () => {
    const albumId = await insertLibraryAlbum(sql, 'insert-path');
    insertedAlbumIds.push(albumId);

    await upsertMatch(sql, albumId, FULL_PAYLOAD);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].artwork_url).toBe(FULL_PAYLOAD.artwork_url);
    expect(rows[0].discogs_url).toBe(FULL_PAYLOAD.discogs_url);
    expect(rows[0].release_year).toBe(FULL_PAYLOAD.release_year);
    expect(rows[0].spotify_url).toBe(FULL_PAYLOAD.spotify_url);
    expect(rows[0].apple_music_url).toBe(FULL_PAYLOAD.apple_music_url);
    expect(rows[0].youtube_music_url).toBe(FULL_PAYLOAD.youtube_music_url);
    expect(rows[0].bandcamp_url).toBe(FULL_PAYLOAD.bandcamp_url);
    expect(rows[0].soundcloud_url).toBe(FULL_PAYLOAD.soundcloud_url);
    expect(rows[0].artist_bio).toBe(FULL_PAYLOAD.artist_bio);
    expect(rows[0].artist_wikipedia_url).toBe(FULL_PAYLOAD.artist_wikipedia_url);
    expect(rows[0].updated_at).not.toBeNull();
  });

  test('BS#1336: the 8 LML-only columns round-trip through PG (text[] + jsonb)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'lml-extended');
    insertedAlbumIds.push(albumId);

    await upsertMatchExtended(sql, albumId, EXTENDED_PAYLOAD);

    const rows = await sql`
      SELECT discogs_artist_id, label, full_release_date, genres, styles, tracklist,
             artist_image_url, bio_tokens
        FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Scalars.
    expect(row.discogs_artist_id).toBe(3840);
    expect(row.label).toBe('Sonamos');
    expect(row.full_release_date).toBe('2022-09-30');
    expect(row.artist_image_url).toBe(EXTENDED_PAYLOAD.artist_image_url);
    // text[] must come back as a JS array, NOT a '{Rock,Jazz}' literal string —
    // the read path (lookupAlbumMetadataByKey) and buildLocalMetadataResponse
    // spread it (`[...persisted.genres]`), which would corrupt a string.
    expect(Array.isArray(row.genres)).toBe(true);
    expect(row.genres).toEqual(['Rock', 'Jazz']);
    expect(row.styles).toEqual(['Folk', 'Indie Rock']);
    // jsonb must come back parsed (array of objects), matching the shape the
    // read path hands to projectTracklistForWire / the bioTokens spread.
    expect(row.tracklist).toEqual([{ position: '1', title: 'la paradoja', duration: '4:12' }]);
    expect(row.bio_tokens).toEqual([{ type: 'plainText', text: 'Argentine musician' }]);
  });

  test('UPDATE-on-conflict path: subsequent UPSERT overwrites payload and advances updated_at', async () => {
    const albumId = await insertLibraryAlbum(sql, 'update-path');
    insertedAlbumIds.push(albumId);

    await upsertMatch(sql, albumId, FULL_PAYLOAD);
    const before = await sql`
      SELECT updated_at FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;

    // pg_sleep(0.05) is enough wall-clock movement for `updated_at < NOW()`
    // on the second UPSERT to be unambiguously satisfied. NOW() inside a
    // statement is statement_start; consecutive UPSERTs ARE different.
    await sql`SELECT pg_sleep(0.05)`;

    const newer = { ...FULL_PAYLOAD, artwork_url: 'https://i.discogs.com/d3-test/newer.jpg' };
    await upsertMatch(sql, albumId, newer);

    const after = await sql`
      SELECT artwork_url, updated_at FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(after[0].artwork_url).toBe(newer.artwork_url);
    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(new Date(before[0].updated_at).getTime());
  });

  test('no-match UPSERT preserves 7 untouched columns on existing rows', async () => {
    const albumId = await insertLibraryAlbum(sql, 'no-match-preserve');
    insertedAlbumIds.push(albumId);

    // Seed with a full enrichment first.
    await upsertMatch(sql, albumId, FULL_PAYLOAD);

    await sql`SELECT pg_sleep(0.05)`;

    // Run a no-match UPSERT (only the 3 search URLs). The other 7 columns
    // must survive untouched — the no-match branch's deliberate "preserve
    // prior values" semantics (matches the worker enrich.ts no-match
    // branch + the in-process .then arm's `?? null` on no-match).
    await upsertNoMatch(sql, albumId, SEARCH_URLS);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    // Search URLs overwritten with the new synthesized values.
    expect(rows[0].youtube_music_url).toBe(SEARCH_URLS.youtube_music_url);
    expect(rows[0].bandcamp_url).toBe(SEARCH_URLS.bandcamp_url);
    expect(rows[0].soundcloud_url).toBe(SEARCH_URLS.soundcloud_url);
    // 7 other fields: untouched, still hold the FULL_PAYLOAD values.
    expect(rows[0].artwork_url).toBe(FULL_PAYLOAD.artwork_url);
    expect(rows[0].discogs_url).toBe(FULL_PAYLOAD.discogs_url);
    expect(rows[0].release_year).toBe(FULL_PAYLOAD.release_year);
    expect(rows[0].spotify_url).toBe(FULL_PAYLOAD.spotify_url);
    expect(rows[0].apple_music_url).toBe(FULL_PAYLOAD.apple_music_url);
    expect(rows[0].artist_bio).toBe(FULL_PAYLOAD.artist_bio);
    expect(rows[0].artist_wikipedia_url).toBe(FULL_PAYLOAD.artist_wikipedia_url);
  });

  test('no-match UPSERT into empty album_metadata leaves 7 columns NULL on INSERT', async () => {
    const albumId = await insertLibraryAlbum(sql, 'no-match-fresh');
    insertedAlbumIds.push(albumId);

    // No prior row. The no-match INSERT writes only the 3 URL columns; the
    // 7 others are absent from the column list and PG fills them NULL.
    await upsertNoMatch(sql, albumId, SEARCH_URLS);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(rows[0].youtube_music_url).toBe(SEARCH_URLS.youtube_music_url);
    expect(rows[0].artwork_url).toBeNull();
    expect(rows[0].discogs_url).toBeNull();
    expect(rows[0].release_year).toBeNull();
    expect(rows[0].spotify_url).toBeNull();
    expect(rows[0].apple_music_url).toBeNull();
    expect(rows[0].artist_bio).toBeNull();
    expect(rows[0].artist_wikipedia_url).toBeNull();
  });

  test('catch-arm INSERT ... ON CONFLICT DO NOTHING never clobbers a prior successful enrichment', async () => {
    const albumId = await insertLibraryAlbum(sql, 'catch-arm');
    insertedAlbumIds.push(albumId);

    // Successful enrichment lands first.
    await upsertMatch(sql, albumId, FULL_PAYLOAD);

    // A delayed catch-arm fallback (LML threw on a sibling row, perhaps,
    // or an in-flight request that lost a race) attempts to insert search
    // URLs for the same album. The `ON CONFLICT DO NOTHING` policy
    // guarantees the row stays intact.
    await insertFallbackOnly(sql, albumId, {
      youtube_music_url: 'should-not-overwrite',
      bandcamp_url: 'should-not-overwrite',
      soundcloud_url: 'should-not-overwrite',
    });

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(rows[0].artwork_url).toBe(FULL_PAYLOAD.artwork_url);
    expect(rows[0].artist_bio).toBe(FULL_PAYLOAD.artist_bio);
    expect(rows[0].youtube_music_url).toBe(FULL_PAYLOAD.youtube_music_url);
    expect(rows[0].bandcamp_url).toBe(FULL_PAYLOAD.bandcamp_url);
    expect(rows[0].soundcloud_url).toBe(FULL_PAYLOAD.soundcloud_url);
  });

  test('catch-arm INSERT materializes a fresh row when album_metadata is empty', async () => {
    const albumId = await insertLibraryAlbum(sql, 'catch-arm-fresh');
    insertedAlbumIds.push(albumId);

    await insertFallbackOnly(sql, albumId, SEARCH_URLS);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].youtube_music_url).toBe(SEARCH_URLS.youtube_music_url);
    expect(rows[0].bandcamp_url).toBe(SEARCH_URLS.bandcamp_url);
    expect(rows[0].soundcloud_url).toBe(SEARCH_URLS.soundcloud_url);
    // 7 other fields: NULL — never received an LML success.
    expect(rows[0].artwork_url).toBeNull();
    expect(rows[0].discogs_url).toBeNull();
  });
});
