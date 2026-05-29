/**
 * Integration test for the flowsheet-artwork-repair drain (BS#1209).
 *
 * Exercises one row of each population against real PG. Pins three contracts
 * the unit tests can't observe end-to-end:
 *
 *   1. Free-form UPDATE only fires when `id = $1 AND artwork_url IS NULL
 *      AND metadata_status = 'enriched_match'`. Idempotent across re-runs.
 *   2. Linked UPSERT into `album_metadata` carries `setWhere: updated_at <
 *      NOW()` so a concurrent fresh enrichment landed first cannot be
 *      clobbered.
 *   3. `metadata_status` is NEVER mutated by either path — status-read-only
 *      is the load-bearing acceptance criterion.
 *
 * Pure SQL — no TS imports from `jobs/flowsheet-artwork-repair/`. The
 * integration runner is babel-jest with no TS support; this mirrors the
 * sibling spec at `flowsheet-metadata-backfill-upsert.spec.js`. When the
 * `repair.ts` writers are hand-edited, the SQL here must follow.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Free-form repair UPDATE: mirrors `repairFreeFormRow` in `repair.ts`. The
 * race-guarded WHERE is the load-bearing piece — a concurrent fresh
 * enrichment landing `artwork_url` non-null OR flipping status would
 * kick the row out of the predicate and this UPDATE no-ops.
 */
async function repairFreeForm(sql, flowsheetId, payload) {
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
           artist_wikipedia_url = ${payload.artist_wikipedia_url}
     WHERE id = ${flowsheetId}
       AND artwork_url IS NULL
       AND metadata_status = 'enriched_match'
    RETURNING id
  `;
  return rows.length;
}

/**
 * Linked repair UPSERT: mirrors `repairLinkedAlbum` in `repair.ts`. UPSERTs
 * the 10-column payload + updated_at sentinel; race-guarded by
 * `updated_at < NOW()` on the UPDATE branch.
 */
async function repairLinked(sql, albumId, payload) {
  const rows = await sql`
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
    RETURNING album_id
  `;
  return rows.length;
}

async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'bs1209-artwork-repair-' + suffix}, 9999, 'Stereolab')
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Insert a flowsheet row stranded by LML#408: `metadata_status='enriched_match'`
 * + `artwork_url=NULL`. Optional `albumId` for the linked half (here we
 * still ground the row to test cross-table independence).
 */
async function insertStrandedFlowsheetRow(sql, suffix, albumId = null) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (play_order, entry_type, artist_name, album_title, track_title,
       request_flag, segue, album_id, metadata_status, artwork_url, metadata_attempt_at)
    VALUES
      (99999, 'track', ${'bs1209-artwork-repair-artist-' + suffix},
       'Test Album', 'Test Track', false, false, ${albumId},
       'enriched_match', NULL, NOW() - interval '1 hour')
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Insert an `album_metadata` row stranded by LML#408: `artwork_url=NULL`,
 * `updated_at` set to a past time so the race guard does not block our
 * UPSERT in the happy-path test.
 */
async function insertStrandedAlbumMetadata(sql, albumId) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata
      (album_id, artwork_url, updated_at)
    VALUES
      (${albumId}, NULL, NOW() - interval '1 hour')
  `;
}

const REPAIR_PAYLOAD = {
  artwork_url: 'https://i.discogs.com/bs1209/repaired.jpg',
  discogs_url: 'https://discogs.com/release/1209',
  release_year: 1998,
  spotify_url: 'https://open.spotify.com/album/bs1209',
  apple_music_url: 'https://music.apple.com/album/bs1209',
  youtube_music_url: 'https://music.youtube.com/album/bs1209',
  bandcamp_url: 'https://stereolab.bandcamp.com/album/bs1209',
  soundcloud_url: null,
  artist_bio: 'BS#1209 repair bio.',
  artist_wikipedia_url: 'https://en.wikipedia.org/wiki/BS1209_test',
};

describe('flowsheet-artwork-repair drain (real PG, BS#1209)', () => {
  let sql;
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

  test('free-form: 10 cols land on a stranded enriched_match row; metadata_status untouched', async () => {
    const flowsheetId = await insertStrandedFlowsheetRow(sql, 'free-form-happy', null);
    insertedFlowsheetIds.push(flowsheetId);

    const affected = await repairFreeForm(sql, flowsheetId, REPAIR_PAYLOAD);
    expect(affected).toBe(1);

    const rows = await sql`
      SELECT artwork_url, discogs_url, release_year, spotify_url, apple_music_url,
             youtube_music_url, bandcamp_url, soundcloud_url, artist_bio,
             artist_wikipedia_url, metadata_status, album_id
      FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(rows[0].artwork_url).toBe(REPAIR_PAYLOAD.artwork_url);
    expect(rows[0].discogs_url).toBe(REPAIR_PAYLOAD.discogs_url);
    expect(rows[0].release_year).toBe(REPAIR_PAYLOAD.release_year);
    expect(rows[0].artist_bio).toBe(REPAIR_PAYLOAD.artist_bio);
    // Status invariant — drain is read-only on metadata_status
    expect(rows[0].metadata_status).toBe('enriched_match');
    // album_id stays null on free-form rows
    expect(rows[0].album_id).toBeNull();
  });

  test('free-form race guard: re-running on an already-repaired row no-ops (idempotent)', async () => {
    const flowsheetId = await insertStrandedFlowsheetRow(sql, 'free-form-idem', null);
    insertedFlowsheetIds.push(flowsheetId);

    const first = await repairFreeForm(sql, flowsheetId, REPAIR_PAYLOAD);
    expect(first).toBe(1);
    // Second run sees artwork_url non-null → WHERE no longer matches
    const second = await repairFreeForm(sql, flowsheetId, REPAIR_PAYLOAD);
    expect(second).toBe(0);

    // Data is still the original repair (no clobber)
    const rows = await sql`
      SELECT artwork_url FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(rows[0].artwork_url).toBe(REPAIR_PAYLOAD.artwork_url);
  });

  test('free-form race guard: status flipped to enriched_no_match → WHERE no longer matches', async () => {
    const flowsheetId = await insertStrandedFlowsheetRow(sql, 'free-form-status-flip', null);
    insertedFlowsheetIds.push(flowsheetId);

    // Simulate the LML#400 follow-up backfill flipping the status before
    // this drain reaches the row.
    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet
         SET metadata_status = 'enriched_no_match'
       WHERE id = ${flowsheetId}
    `;

    const affected = await repairFreeForm(sql, flowsheetId, REPAIR_PAYLOAD);
    expect(affected).toBe(0);

    const rows = await sql`
      SELECT artwork_url, metadata_status FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(rows[0].artwork_url).toBeNull();
    expect(rows[0].metadata_status).toBe('enriched_no_match');
  });

  test('linked: UPSERT writes 10 cols on a stranded album_metadata row; no flowsheet write', async () => {
    const albumId = await insertLibraryAlbum(sql, 'linked-happy');
    insertedAlbumIds.push(albumId);
    await insertStrandedAlbumMetadata(sql, albumId);
    const flowsheetId = await insertStrandedFlowsheetRow(sql, 'linked-happy', albumId);
    insertedFlowsheetIds.push(flowsheetId);

    const beforeFsArtwork = await sql`
      SELECT artwork_url, metadata_status FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;

    const affected = await repairLinked(sql, albumId, REPAIR_PAYLOAD);
    expect(affected).toBe(1);

    // album_metadata carries the repair
    const amRows = await sql`
      SELECT artwork_url, discogs_url, release_year, artist_bio
      FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(amRows).toHaveLength(1);
    expect(amRows[0].artwork_url).toBe(REPAIR_PAYLOAD.artwork_url);
    expect(amRows[0].discogs_url).toBe(REPAIR_PAYLOAD.discogs_url);
    expect(amRows[0].release_year).toBe(REPAIR_PAYLOAD.release_year);
    expect(amRows[0].artist_bio).toBe(REPAIR_PAYLOAD.artist_bio);

    // flowsheet row UNCHANGED — the read-path COALESCE join picks up the
    // album_metadata fix automatically.
    const afterFsRows = await sql`
      SELECT artwork_url, metadata_status FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${flowsheetId}
    `;
    expect(afterFsRows[0].artwork_url).toBe(beforeFsArtwork[0].artwork_url);
    expect(afterFsRows[0].metadata_status).toBe(beforeFsArtwork[0].metadata_status);
    expect(afterFsRows[0].metadata_status).toBe('enriched_match');
  });

  test('linked race guard: setWhere updated_at < NOW() blocks an UPSERT against a freshly-updated row', async () => {
    const albumId = await insertLibraryAlbum(sql, 'linked-race-guard');
    insertedAlbumIds.push(albumId);
    // Insert an album_metadata row with `updated_at = NOW() + 1 minute` —
    // simulates a concurrent fresh enrichment landing strictly after our
    // drain's read window. The setWhere `updated_at < NOW()` evaluates
    // false → ON CONFLICT DO UPDATE no-ops → 0 rows returned.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/fresh-enrichment.jpg',
         NOW() + interval '1 minute')
    `;

    const affected = await repairLinked(sql, albumId, REPAIR_PAYLOAD);
    expect(affected).toBe(0);

    // The fresh enrichment's artwork survives
    const rows = await sql`
      SELECT artwork_url FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    expect(rows[0].artwork_url).toBe('https://i.discogs.com/fresh-enrichment.jpg');
  });
});
