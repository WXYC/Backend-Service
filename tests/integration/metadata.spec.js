const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');
const fls_util = require('../utils/flowsheet_util');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Per-spec sql client used by the BS#897 album_metadata projection block
// below. Mirrors the construction in flowsheet.spec.js / migrations.spec.js.
function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

/**
 * Metadata Integration Tests
 *
 * These tests verify that the metadata service integration works correctly:
 * - Flowsheet entries include metadata fields (artwork_url, spotify_url, etc.)
 * - Fire-and-forget metadata fetch is triggered for tracks (not messages)
 * - Basic flowsheet operations work with metadata joins
 *
 * NOTE: Uses secondary_dj_id to avoid conflicts with flowsheet.spec.js
 * which uses primary_dj_id. This allows parallel test execution.
 */

// Use secondary DJ to avoid conflicts with flowsheet.spec.js
const getTestDjId = () => global.secondary_dj_id;

describe('Metadata Fields in Flowsheet Response', () => {
  beforeEach(async () => {
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('Response includes all metadata fields (even if null)', async () => {
    // Add a track (uses album 4 to avoid conflicts with flowsheet.spec.js in parallel)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4, // Sufjan Stevens - Illinois
        track_title: 'Chicago',
      })
      .expect(201);

    // Get the flowsheet entries
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);

    // Find the track entry (not a message)
    const trackEntry = getRes.body.entries.find((e) => e.track_title === 'Chicago');
    expect(trackEntry).toBeDefined();

    // Verify metadata fields are present at the top level (flattened in V2)
    // These may be null initially (fire-and-forget hasn't completed)
    expect(trackEntry).toHaveProperty('artwork_url');
    expect(trackEntry).toHaveProperty('discogs_url');
    expect(trackEntry).toHaveProperty('release_year');
    expect(trackEntry).toHaveProperty('spotify_url');
    expect(trackEntry).toHaveProperty('apple_music_url');
    expect(trackEntry).toHaveProperty('youtube_music_url');
    expect(trackEntry).toHaveProperty('bandcamp_url');
    expect(trackEntry).toHaveProperty('soundcloud_url');
    expect(trackEntry).toHaveProperty('artist_bio');
    expect(trackEntry).toHaveProperty('artist_wikipedia_url');
  });

  test('/flowsheet/latest includes metadata fields', async () => {
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 5, // Kendrick Lamar - To Pimp a Butterfly
        track_title: 'Alright',
      })
      .expect(201);

    const res = await request.get('/flowsheet/latest').expect(200);

    // Verify metadata fields are at the top level (flattened in V2)
    expect(res.body).toHaveProperty('artwork_url');
    expect(res.body).toHaveProperty('spotify_url');
    expect(res.body).toHaveProperty('apple_music_url');
    expect(res.body).toHaveProperty('youtube_music_url');
  });
});

describe('Fire-and-Forget Metadata Fetch', () => {
  beforeEach(async () => {
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('Fire-and-forget does not block track insertion for library tracks', async () => {
    // Add a track from the library (uses album 4 to avoid conflicts with flowsheet.spec.js)
    // The key test here is that the response returns immediately,
    // even though metadata fetch is triggered in the background
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4, // Sufjan Stevens - Illinois
        track_title: 'Casimir Pulaski Day',
      })
      .expect(201);

    // Response should return immediately with the entry
    expect(addRes.body.id).toBeDefined();
    expect(addRes.body.track_title).toEqual('Casimir Pulaski Day');
    expect(addRes.body.artist_name).toEqual('Sufjan Stevens');

    // Entry should be queryable immediately
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const entry = getRes.body.entries.find((e) => e.id === addRes.body.id);
    expect(entry).toBeDefined();

    // Metadata fields should exist at the top level (may be null if fetch hasn't completed)
    expect(entry).toHaveProperty('youtube_music_url');
    expect(entry).toHaveProperty('spotify_url');
  });

  test('Fire-and-forget does not block track insertion for non-library tracks', async () => {
    // Add a track without album_id (non-library entry)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Radiohead',
        album_title: 'OK Computer',
        track_title: 'Paranoid Android',
      })
      .expect(201);

    // Response should return immediately
    expect(addRes.body.id).toBeDefined();
    expect(addRes.body.track_title).toEqual('Paranoid Android');
    expect(addRes.body.artist_name).toEqual('Radiohead');

    // Entry should be queryable immediately
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const entry = getRes.body.entries.find((e) => e.id === addRes.body.id);
    expect(entry).toBeDefined();
  });

  test('Messages/talksets do not trigger metadata fetch', async () => {
    // Add a message (no artist_name)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        message: 'PSA: Station ID at the top of the hour',
      })
      .expect(201);

    const entryId = addRes.body.id;

    // Get the entry immediately
    const getRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);

    // Messages get entry_type 'message' (inferred from content), so the V2
    // transform returns them without any metadata fields
    const messageEntry = getRes.body.entries.find((e) => e.id === entryId);
    expect(messageEntry).toBeDefined();
    expect(messageEntry.entry_type).toBe('message');

    // Message entries should not include metadata fields at all
    expect(messageEntry.artwork_url).toBeUndefined();
    expect(messageEntry.spotify_url).toBeUndefined();
    expect(messageEntry.youtube_music_url).toBeUndefined();
  });
});

describe('Flowsheet CRUD with Metadata', () => {
  beforeEach(async () => {
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('New tracks appear in subsequent queries', async () => {
    // Add a new track (uses album 5 to avoid conflicts with flowsheet.spec.js)
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 5,
        track_title: 'CRUD Test Track',
      })
      .expect(201);

    // Get entries - should include new entry
    const res = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);

    const newEntry = res.body.entries.find((e) => e.track_title === 'CRUD Test Track');
    expect(newEntry).toBeDefined();
  });

  test('Deleted tracks are removed from queries', async () => {
    // Add a track to delete (uses album 6 to avoid conflicts with flowsheet.spec.js)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 6,
        track_title: 'Delete Test Track',
      })
      .expect(201);

    const entryId = addRes.body.id;

    // Verify it appears in GET
    const res1 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    expect(res1.body.entries.some((e) => e.id === entryId)).toBe(true);

    // Delete the track
    await request
      .delete('/flowsheet')
      .set('Authorization', global.access_token)
      .send({ entry_id: entryId })
      .expect(200);

    // Verify it's removed from GET
    const res2 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    expect(res2.body.entries.some((e) => e.id === entryId)).toBe(false);
  });

  test('Updated tracks reflect changes in queries', async () => {
    // Add a track (uses album 4 to avoid conflicts with flowsheet.spec.js)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4,
        track_title: 'Update Test Original',
      })
      .expect(201);

    const entryId = addRes.body.id;

    // Update the track
    await request
      .patch('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id: entryId,
        data: { track_title: 'Update Test Modified' },
      })
      .expect(200);

    // Verify update appears in GET
    const res = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const updatedEntry = res.body.entries.find((e) => e.id === entryId);
    expect(updatedEntry).toBeDefined();
    expect(updatedEntry.track_title).toEqual('Update Test Modified');
  });

  test('Pagination works correctly', async () => {
    // Request with offset > 0 should work
    const res = await request.get('/flowsheet').query({ page: 1, limit: 30 }).send();

    // Should succeed (may return 200 with data or 404 if no data at that offset)
    expect([200, 404]).toContain(res.status);
  });
});

describe('Metadata with Rotation Entries', () => {
  beforeEach(async () => {
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('Rotation entries include rotation_bin', async () => {
    // Add a track with rotation_id (album_id 4 is in rotation per seed with rotation_id 2)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4,
        track_title: 'Rotation Test Track',
        rotation_id: 2,
      })
      .expect(201);

    // Get the entry
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const rotationEntry = getRes.body.entries.find((e) => e.track_title === 'Rotation Test Track');

    expect(rotationEntry).toBeDefined();
    expect(rotationEntry.rotation_id).toEqual(2);
    expect(rotationEntry.rotation_bin).toEqual('M'); // From seed data
  });
});

describe('album_metadata COALESCE projection (BS#897)', () => {
  // D1 ships an empty `album_metadata` table; production reads still see
  // every metadata value via the flowsheet inline columns. This test
  // verifies the projection contract that D2/D3 depend on: when an
  // `album_metadata` row exists for the joined `album_id`, the V2 read
  // path returns its values in preference to the flowsheet inline values.
  // Using direct SQL to seed `album_metadata` (no HTTP write path exists
  // until D3) and asserting on the HTTP V2 read.
  //
  // The fire-and-forget LML enrichment may race the GET and overwrite
  // flowsheet's inline metadata after the POST resolves — irrelevant,
  // because COALESCE prefers `album_metadata` so the assertion is
  // race-free.

  let sql;
  const SENTINEL_ALBUM_ID = 5; // Sufjan-adjacent seed row used elsewhere
  const SENTINEL = {
    artwork_url: 'https://bs897.example.com/artwork.jpg',
    discogs_url: 'https://bs897.example.com/discogs',
    release_year: 1979,
    spotify_url: 'https://bs897.example.com/spotify',
    apple_music_url: 'https://bs897.example.com/apple',
    youtube_music_url: 'https://bs897.example.com/youtube',
    bandcamp_url: 'https://bs897.example.com/bandcamp',
    soundcloud_url: 'https://bs897.example.com/soundcloud',
    artist_bio: 'BS#897 sentinel bio',
    artist_wikipedia_url: 'https://bs897.example.com/wiki',
  };

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  beforeEach(async () => {
    // Ensure no stale row survives a prior run; FK ON DELETE CASCADE means
    // the row is also auto-dropped if the library row ever goes away.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_metadata WHERE album_id = ${SENTINEL_ALBUM_ID}`);
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_metadata WHERE album_id = ${SENTINEL_ALBUM_ID}`);
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('V2 read returns album_metadata values when the row exists, regardless of flowsheet inline state', async () => {
    // Pre-populate album_metadata for the sentinel album.
    await sql`
      INSERT INTO ${sql(`${SCHEMA}.album_metadata`)} (
        album_id, artwork_url, discogs_url, release_year, spotify_url,
        apple_music_url, youtube_music_url, bandcamp_url, soundcloud_url,
        artist_bio, artist_wikipedia_url
      ) VALUES (
        ${SENTINEL_ALBUM_ID}, ${SENTINEL.artwork_url}, ${SENTINEL.discogs_url},
        ${SENTINEL.release_year}, ${SENTINEL.spotify_url},
        ${SENTINEL.apple_music_url}, ${SENTINEL.youtube_music_url},
        ${SENTINEL.bandcamp_url}, ${SENTINEL.soundcloud_url},
        ${SENTINEL.artist_bio}, ${SENTINEL.artist_wikipedia_url}
      )
    `;

    // Add a flowsheet track linked to the sentinel album. The fire-and-
    // forget enrichment may run and overwrite flowsheet's inline cols
    // before the GET below, but COALESCE prefers album_metadata so the
    // sentinel values still win.
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: SENTINEL_ALBUM_ID,
        track_title: 'BS897 projection test track',
      })
      .expect(201);

    const getRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const entry = getRes.body.entries.find((e) => e.id === addRes.body.id);
    expect(entry).toBeDefined();

    expect(entry.artwork_url).toEqual(SENTINEL.artwork_url);
    expect(entry.discogs_url).toEqual(SENTINEL.discogs_url);
    expect(entry.release_year).toEqual(SENTINEL.release_year);
    expect(entry.spotify_url).toEqual(SENTINEL.spotify_url);
    expect(entry.apple_music_url).toEqual(SENTINEL.apple_music_url);
    expect(entry.youtube_music_url).toEqual(SENTINEL.youtube_music_url);
    expect(entry.bandcamp_url).toEqual(SENTINEL.bandcamp_url);
    expect(entry.soundcloud_url).toEqual(SENTINEL.soundcloud_url);
    expect(entry.artist_bio).toEqual(SENTINEL.artist_bio);
    expect(entry.artist_wikipedia_url).toEqual(SENTINEL.artist_wikipedia_url);
  });

  test('V2 read falls through to flowsheet inline metadata when no album_metadata row exists', async () => {
    // No album_metadata insert — the beforeEach already cleared the
    // sentinel row, so the LEFT JOIN misses and COALESCE returns the
    // flowsheet side. Whether that side is populated depends on the
    // fire-and-forget LML enrichment, but the contract under test here
    // is "projection doesn't synthesize values from thin air" — i.e.,
    // the sentinel values from the previous test must NOT leak.
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: SENTINEL_ALBUM_ID,
        track_title: 'BS897 fallthrough test track',
      })
      .expect(201);

    const getRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const entry = getRes.body.entries.find((e) => e.id === addRes.body.id);
    expect(entry).toBeDefined();

    // The sentinel strings from the prior test must not appear here.
    expect(entry.artwork_url).not.toEqual(SENTINEL.artwork_url);
    expect(entry.discogs_url).not.toEqual(SENTINEL.discogs_url);
    expect(entry.artist_bio).not.toEqual(SENTINEL.artist_bio);
  });
});

describe('Metadata Service Initialization', () => {
  test('Backend healthcheck passes (metadata service initialized)', async () => {
    // Body conforms to HealthCheckResponse from @wxyc/shared (#804).
    const res = await request.get('/healthcheck').expect(200);
    expect(res.body.status).toEqual('healthy');
    expect(res.body.services).toEqual({ database: 'ok' });
  });
});

describe('Flowsheet Cache Behavior', () => {
  beforeEach(async () => {
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('Repeated first-page queries return consistent results', async () => {
    // Add a track to ensure there's data
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4,
        track_title: 'Cache Consistency Test',
      })
      .expect(201);

    // Query multiple times - should return consistent results
    const res1 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const res2 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const res3 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);

    // All responses should have the same entries
    expect(res1.body.entries.length).toEqual(res2.body.entries.length);
    expect(res2.body.entries.length).toEqual(res3.body.entries.length);
    expect(res1.body.entries.map((e) => e.id)).toEqual(res2.body.entries.map((e) => e.id));
    expect(res2.body.entries.map((e) => e.id)).toEqual(res3.body.entries.map((e) => e.id));
  });

  test('Cache is invalidated after adding a track', async () => {
    // Add a new track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 5,
        track_title: 'Cache Invalidation Test Add',
      })
      .expect(201);

    // Query - should include the new entry (proves cache was invalidated)
    const afterRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);

    // New entry should be in results (it's the most recent, so should be first)
    expect(afterRes.body.entries.some((e) => e.id === addRes.body.id)).toBe(true);
  });

  test('Cache is invalidated after deleting a track', async () => {
    // Add a track first
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4,
        track_title: 'Cache Invalidation Test Delete',
      })
      .expect(201);

    const entryId = addRes.body.id;

    // Verify it's in the cache
    const beforeRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    expect(beforeRes.body.entries.some((e) => e.id === entryId)).toBe(true);

    // Delete the track
    await request
      .delete('/flowsheet')
      .set('Authorization', global.access_token)
      .send({ entry_id: entryId })
      .expect(200);

    // Query again - entry should be gone
    const afterRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    expect(afterRes.body.entries.some((e) => e.id === entryId)).toBe(false);
  });

  test('Cache is invalidated after updating a track', async () => {
    // Add a track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 4,
        track_title: 'Cache Update Original',
      })
      .expect(201);

    const entryId = addRes.body.id;

    // Verify original title is in cache
    const beforeRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    const beforeEntry = beforeRes.body.entries.find((e) => e.id === entryId);
    expect(beforeEntry.track_title).toEqual('Cache Update Original');

    // Update the track
    await request
      .patch('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id: entryId,
        data: { track_title: 'Cache Update Modified' },
      })
      .expect(200);

    // Query again - should reflect the update
    const afterRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    const afterEntry = afterRes.body.entries.find((e) => e.id === entryId);
    expect(afterEntry.track_title).toEqual('Cache Update Modified');
  });
});

describe('Conditional GET (304 Not Modified)', () => {
  beforeEach(async () => {
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  describe('Last-Modified header', () => {
    test('GET /flowsheet returns Last-Modified header', async () => {
      const res = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);

      expect(res.headers['last-modified']).toBeDefined();
      // Should be a valid HTTP date
      const lastModified = new Date(res.headers['last-modified']);
      expect(lastModified.getTime()).not.toBeNaN();
    });

    test('GET /flowsheet/latest returns Last-Modified header', async () => {
      // Add a track first so there's data (uses album 4 to avoid conflicts)
      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          album_id: 4,
          track_title: 'Last-Modified Header Test',
        })
        .expect(201);

      const res = await request.get('/flowsheet/latest').expect(200);

      expect(res.headers['last-modified']).toBeDefined();
    });
  });

  describe('If-Modified-Since header', () => {
    test('Returns 304 when If-Modified-Since is current', async () => {
      // First request to get the Last-Modified timestamp
      const initialRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Second request with If-Modified-Since header
      const cachedRes = await request
        .get('/flowsheet')
        .query({ limit: 10 })
        .set('If-Modified-Since', lastModified)
        .send()
        .expect(304);

      // 304 responses should have no body
      expect(cachedRes.body).toEqual({});
    });

    test('Returns 200 with data when content has been modified', async () => {
      // First request to get the Last-Modified timestamp
      const initialRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Add a new track to modify the flowsheet
      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          album_id: 4,
          track_title: 'Modification Test Track',
        })
        .expect(201);

      // Request with old If-Modified-Since should return 200 with new data
      const updatedRes = await request
        .get('/flowsheet')
        .query({ limit: 10 })
        .set('If-Modified-Since', lastModified)
        .send()
        .expect(200);

      expect(updatedRes.body.entries.length).toBeGreaterThan(0);
      expect(updatedRes.headers['last-modified']).toBeDefined();
      // The new Last-Modified should be different (later) than the old one
      expect(new Date(updatedRes.headers['last-modified']).getTime()).toBeGreaterThan(new Date(lastModified).getTime());
    });

    test('/flowsheet/latest returns 304 when not modified', async () => {
      // Add a track so there's data (uses album 5 to avoid conflicts)
      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          album_id: 5,
          track_title: 'Latest 304 Test',
        })
        .expect(201);

      // First request to get timestamp
      const initialRes = await request.get('/flowsheet/latest').expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Second request should return 304
      await request.get('/flowsheet/latest').set('If-Modified-Since', lastModified).send().expect(304);
    });

    test('Returns 200 when If-Modified-Since is invalid date', async () => {
      const res = await request
        .get('/flowsheet')
        .query({ limit: 10 })
        .set('If-Modified-Since', 'not-a-valid-date')
        .send()
        .expect(200);

      expect(res.headers['last-modified']).toBeDefined();
    });
  });

  describe('since query parameter', () => {
    test('Returns 304 when since param is current', async () => {
      // First request to get the Last-Modified timestamp
      const initialRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Second request with since query param
      const cachedRes = await request.get('/flowsheet').query({ limit: 10, since: lastModified }).send().expect(304);

      expect(cachedRes.body).toEqual({});
    });

    test('Returns 200 when since param is stale', async () => {
      // First request to get the Last-Modified timestamp
      const initialRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Add a new track to modify the flowsheet (uses album 4 to avoid conflicts)
      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          album_id: 4,
          track_title: 'Since Query Param Test',
        })
        .expect(201);

      // Request with old since param should return 200 with new data
      const updatedRes = await request.get('/flowsheet').query({ limit: 10, since: lastModified }).send().expect(200);

      expect(updatedRes.body.entries.length).toBeGreaterThan(0);
    });

    test('Returns 200 when since param is invalid date', async () => {
      const res = await request.get('/flowsheet').query({ limit: 10, since: 'invalid-date' }).send().expect(200);

      expect(res.headers['last-modified']).toBeDefined();
    });

    test('since query param takes precedence over If-Modified-Since header', async () => {
      // First request to get the Last-Modified timestamp
      const initialRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Add a track to modify the flowsheet (uses album 4 to avoid conflicts)
      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          album_id: 4,
          track_title: 'Precedence Test Track',
        })
        .expect(201);

      // Get the new Last-Modified
      const updatedRes = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
      const newLastModified = updatedRes.headers['last-modified'];

      // Request with current since param but old header - should return 304
      // (since param takes precedence, and it's current)
      await request
        .get('/flowsheet')
        .query({ limit: 10, since: newLastModified })
        .set('If-Modified-Since', lastModified)
        .send()
        .expect(304);
    });

    test('/flowsheet/latest supports since query param', async () => {
      // Add a track so there's data (uses album 5 to avoid conflicts)
      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          album_id: 5,
          track_title: 'Latest Since Test',
        })
        .expect(201);

      // First request to get timestamp
      const initialRes = await request.get('/flowsheet/latest').expect(200);
      const lastModified = initialRes.headers['last-modified'];

      // Second request with since param should return 304
      await request.get('/flowsheet/latest').query({ since: lastModified }).send().expect(304);
    });
  });
});
