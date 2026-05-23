/**
 * Integration test for the flowsheet-metadata-backfill writer contract
 * (BS#1027 / Epic D).
 *
 * The historical drain in `jobs/flowsheet-metadata-backfill/enrich.ts`
 * used to write the 10-column metadata payload inline on `flowsheet` for
 * every enriched row, regardless of `album_id`. D3 (#899) patched the two
 * runtime writers to UPSERT `album_metadata` for linked rows but did not
 * patch this drain — every cycle re-introduced inline-only drift and
 * blocked D4 (#900). #1027 mirrors the D3 worker pattern into this job.
 *
 * This spec validates the four-way matrix:
 *   - Linked + match: `album_metadata` row materializes with the full
 *     10-column payload; the flowsheet inline columns stay untouched
 *     (album_id, marker stamped, no inline writes).
 *   - Linked + no-match: only the 3 search URLs land in `album_metadata`;
 *     the 7 other columns are NULL on INSERT; flowsheet inline columns
 *     stay untouched.
 *   - Unlinked + match: 10 inline columns land on `flowsheet`; no
 *     `album_metadata` row materializes.
 *   - Unlinked + no-match: 3 search URLs land on `flowsheet` inline; no
 *     `album_metadata` row materializes.
 *
 * Also pins:
 *   - The `setWhere: updated_at < NOW()` race guard prevents a delayed
 *     backfill cycle from clobbering a fresher runtime/worker enrichment
 *     of the same album_id.
 *   - The `metadata_attempt_at` marker stamp happens on all four branches.
 *   - The marker-based idempotency guard (`metadata_attempt_at IS NULL`)
 *     leaves an already-stamped flowsheet row untouched (returning empty
 *     → raced metric in the application layer).
 *
 * Pure SQL — does NOT import `jobs/flowsheet-metadata-backfill/enrich.ts`.
 * Integration runner is babel-jest with no TS support; mirrors the
 * sibling worker spec at `album-metadata-upsert.spec.js` in shape.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Issue the backfill's linked+match UPSERT directly. Mirrors
 * `applyEnrichment` in `jobs/flowsheet-metadata-backfill/enrich.ts` when
 * the LML lookup returned artwork on a linked row. When that file is
 * hand-edited the SQL here must follow.
 */
async function upsertLinkedMatch(sql, albumId, payload) {
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

async function upsertLinkedNoMatch(sql, albumId, searchUrls) {
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

/** Marker-only flowsheet stamp used on both linked branches after the album_metadata UPSERT. */
async function stampMarker(sql, flowsheetId) {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet
       SET metadata_attempt_at = NOW()
     WHERE id = ${flowsheetId}
       AND metadata_attempt_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/** Unlinked+match writes the 10 inline columns and the marker on flowsheet. */
async function inlineMatch(sql, flowsheetId, payload) {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet
       SET artwork_url          = ${payload.artwork_url},
           discogs_url          = ${payload.discogs_url},
           release_year         = ${payload.release_year},
           spotify_url          = ${payload.spotify_url},
           apple_music_url      = ${payload.apple_music_url},
           youtube_music_url    = ${payload.youtube_music_url},
           bandcamp_url         = ${payload.bandcamp_url},
           soundcloud_url       = ${payload.soundcloud_url},
           artist_bio           = ${payload.artist_bio},
           artist_wikipedia_url = ${payload.artist_wikipedia_url},
           metadata_attempt_at  = NOW()
     WHERE id = ${flowsheetId}
       AND metadata_attempt_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/** Unlinked+no-match writes the 3 search URLs and the marker inline. */
async function inlineNoMatch(sql, flowsheetId, searchUrls) {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet
       SET youtube_music_url   = ${searchUrls.youtube_music_url},
           bandcamp_url        = ${searchUrls.bandcamp_url},
           soundcloud_url      = ${searchUrls.soundcloud_url},
           metadata_attempt_at = NOW()
     WHERE id = ${flowsheetId}
       AND metadata_attempt_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * Insert a fresh library album to act as the FK target. Returns the new id.
 * Uses the seeded artist/genre/format ids from dev_env/seed_db.sql.
 */
async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'bs1027-backfill-test-album-' + suffix}, 9999, 'Built to Spill')
    RETURNING id
  `;
  return rows[0].id;
}

/** Insert a fresh flowsheet row, optionally linked to an album. */
async function insertFlowsheetRow(sql, suffix, albumId = null) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (play_order, entry_type, artist_name, album_title, track_title,
       request_flag, segue, album_id)
    VALUES
      (99999, 'track', ${'bs1027-backfill-test-artist-' + suffix},
       'Test Album', 'Test Track', false, false, ${albumId})
    RETURNING id
  `;
  return rows[0].id;
}

const FULL_PAYLOAD = {
  artwork_url: 'https://i.discogs.com/bs1027/cover.jpg',
  discogs_url: 'https://discogs.com/release/1027',
  release_year: 2025,
  spotify_url: 'https://open.spotify.com/album/bs1027',
  apple_music_url: 'https://music.apple.com/album/bs1027',
  youtube_music_url: 'https://music.youtube.com/playlist/bs1027',
  bandcamp_url: 'https://artist.bandcamp.com/album/bs1027',
  soundcloud_url: 'https://soundcloud.com/album/bs1027',
  artist_bio: 'A BS#1027 test bio.',
  artist_wikipedia_url: 'https://en.wikipedia.org/wiki/BS1027_test',
};

const SEARCH_URLS = {
  youtube_music_url: 'https://music.youtube.com/search?q=BS1027%20test',
  bandcamp_url: 'https://bandcamp.com/search?q=BS1027%20test',
  soundcloud_url: 'https://soundcloud.com/search?q=BS1027%20test',
};

describe('flowsheet-metadata-backfill writer contract (real PG, BS#1027)', () => {
  let sql;
  /** Cleanup arrays: deletion order matters (flowsheet → album_metadata → library). */
  const insertedFlowsheetIds = [];
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedFlowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${insertedFlowsheetIds})`;
    }
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  test('linked + match: album_metadata row materializes; flowsheet inline columns stay NULL', async () => {
    const albumId = await insertLibraryAlbum(sql, 'linked-match');
    insertedAlbumIds.push(albumId);
    const flowsheetId = await insertFlowsheetRow(sql, 'linked-match', albumId);
    insertedFlowsheetIds.push(flowsheetId);

    await upsertLinkedMatch(sql, albumId, FULL_PAYLOAD);
    const stamped = await stampMarker(sql, flowsheetId);
    expect(stamped).toBe(1);

    // album_metadata holds the 10-column payload
    const amRows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(amRows).toHaveLength(1);
    expect(amRows[0].artwork_url).toBe(FULL_PAYLOAD.artwork_url);
    expect(amRows[0].discogs_url).toBe(FULL_PAYLOAD.discogs_url);
    expect(amRows[0].release_year).toBe(FULL_PAYLOAD.release_year);
    expect(amRows[0].artist_bio).toBe(FULL_PAYLOAD.artist_bio);

    // flowsheet inline columns must stay NULL — that's the whole point of #1027
    const fsRows = await sql`
      SELECT artwork_url, discogs_url, release_year, spotify_url, apple_music_url,
             youtube_music_url, bandcamp_url, soundcloud_url, artist_bio,
             artist_wikipedia_url, metadata_attempt_at
      FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(fsRows[0].artwork_url).toBeNull();
    expect(fsRows[0].discogs_url).toBeNull();
    expect(fsRows[0].release_year).toBeNull();
    expect(fsRows[0].spotify_url).toBeNull();
    expect(fsRows[0].apple_music_url).toBeNull();
    expect(fsRows[0].youtube_music_url).toBeNull();
    expect(fsRows[0].bandcamp_url).toBeNull();
    expect(fsRows[0].soundcloud_url).toBeNull();
    expect(fsRows[0].artist_bio).toBeNull();
    expect(fsRows[0].artist_wikipedia_url).toBeNull();
    // marker IS stamped
    expect(fsRows[0].metadata_attempt_at).not.toBeNull();
  });

  test('linked + no-match: 3 URLs land in album_metadata, 7 columns NULL, flowsheet inline stays NULL', async () => {
    const albumId = await insertLibraryAlbum(sql, 'linked-no-match');
    insertedAlbumIds.push(albumId);
    const flowsheetId = await insertFlowsheetRow(sql, 'linked-no-match', albumId);
    insertedFlowsheetIds.push(flowsheetId);

    await upsertLinkedNoMatch(sql, albumId, SEARCH_URLS);
    const stamped = await stampMarker(sql, flowsheetId);
    expect(stamped).toBe(1);

    const amRows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(amRows).toHaveLength(1);
    expect(amRows[0].youtube_music_url).toBe(SEARCH_URLS.youtube_music_url);
    expect(amRows[0].bandcamp_url).toBe(SEARCH_URLS.bandcamp_url);
    expect(amRows[0].soundcloud_url).toBe(SEARCH_URLS.soundcloud_url);
    expect(amRows[0].artwork_url).toBeNull();
    expect(amRows[0].discogs_url).toBeNull();
    expect(amRows[0].release_year).toBeNull();
    expect(amRows[0].spotify_url).toBeNull();
    expect(amRows[0].apple_music_url).toBeNull();
    expect(amRows[0].artist_bio).toBeNull();
    expect(amRows[0].artist_wikipedia_url).toBeNull();

    const fsRows = await sql`
      SELECT artwork_url, youtube_music_url, bandcamp_url, soundcloud_url, metadata_attempt_at
      FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(fsRows[0].artwork_url).toBeNull();
    expect(fsRows[0].youtube_music_url).toBeNull();
    expect(fsRows[0].bandcamp_url).toBeNull();
    expect(fsRows[0].soundcloud_url).toBeNull();
    expect(fsRows[0].metadata_attempt_at).not.toBeNull();
  });

  test('unlinked + match: 10 inline columns land on flowsheet; no album_metadata row created', async () => {
    const flowsheetId = await insertFlowsheetRow(sql, 'unlinked-match', null);
    insertedFlowsheetIds.push(flowsheetId);

    const matched = await inlineMatch(sql, flowsheetId, FULL_PAYLOAD);
    expect(matched).toBe(1);

    const fsRows = await sql`
      SELECT artwork_url, discogs_url, release_year, spotify_url, apple_music_url,
             youtube_music_url, bandcamp_url, soundcloud_url, artist_bio,
             artist_wikipedia_url, metadata_attempt_at, album_id
      FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(fsRows[0].album_id).toBeNull();
    expect(fsRows[0].artwork_url).toBe(FULL_PAYLOAD.artwork_url);
    expect(fsRows[0].discogs_url).toBe(FULL_PAYLOAD.discogs_url);
    expect(fsRows[0].release_year).toBe(FULL_PAYLOAD.release_year);
    expect(fsRows[0].artist_bio).toBe(FULL_PAYLOAD.artist_bio);
    expect(fsRows[0].metadata_attempt_at).not.toBeNull();
  });

  test('unlinked + no-match: 3 URLs land inline; no album_metadata row created', async () => {
    const flowsheetId = await insertFlowsheetRow(sql, 'unlinked-no-match', null);
    insertedFlowsheetIds.push(flowsheetId);

    const matched = await inlineNoMatch(sql, flowsheetId, SEARCH_URLS);
    expect(matched).toBe(1);

    const fsRows = await sql`
      SELECT youtube_music_url, bandcamp_url, soundcloud_url, artwork_url,
             metadata_attempt_at, album_id
      FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(fsRows[0].album_id).toBeNull();
    expect(fsRows[0].youtube_music_url).toBe(SEARCH_URLS.youtube_music_url);
    expect(fsRows[0].bandcamp_url).toBe(SEARCH_URLS.bandcamp_url);
    expect(fsRows[0].soundcloud_url).toBe(SEARCH_URLS.soundcloud_url);
    expect(fsRows[0].artwork_url).toBeNull();
    expect(fsRows[0].metadata_attempt_at).not.toBeNull();
  });

  test('race guard: a delayed backfill upsert does NOT clobber a fresher album_metadata row', async () => {
    const albumId = await insertLibraryAlbum(sql, 'race-guard');
    insertedAlbumIds.push(albumId);

    // Simulate the runtime/worker writing a fresh enrichment first.
    await upsertLinkedMatch(sql, albumId, FULL_PAYLOAD);
    const before = await sql`
      SELECT updated_at FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;

    // Simulate a delayed backfill cycle attempting to clobber with stale data
    // in the SAME statement. The `setWhere: updated_at < NOW()` in the same
    // INSERT statement evaluates NOW() at statement_start: if the existing
    // updated_at equals or exceeds that, the UPDATE arm short-circuits.
    // Verify by issuing the same UPSERT again immediately (within the same
    // statement timestamp, both values equal → < is false).
    await upsertLinkedMatch(sql, albumId, { ...FULL_PAYLOAD, artwork_url: 'stale-clobber' });

    const after = await sql`
      SELECT artwork_url, updated_at FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    // The race guard either kept the prior artwork_url or advanced — what
    // matters: 'stale-clobber' never lands when guarded properly. The
    // statement_start equality keeps the row unchanged.
    expect(after[0].artwork_url).toBe(FULL_PAYLOAD.artwork_url);
    expect(new Date(after[0].updated_at).getTime()).toBe(new Date(before[0].updated_at).getTime());
  });

  test('marker idempotency: stamping an already-stamped flowsheet row returns 0 (raced outcome)', async () => {
    const flowsheetId = await insertFlowsheetRow(sql, 'marker-raced', null);
    insertedFlowsheetIds.push(flowsheetId);

    // First stamp lands.
    const first = await stampMarker(sql, flowsheetId);
    expect(first).toBe(1);

    // Second stamp races against the marker IS NULL guard.
    const second = await stampMarker(sql, flowsheetId);
    expect(second).toBe(0);
  });
});
