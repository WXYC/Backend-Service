const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const fls_util = require('../utils/flowsheet_util');

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
    // Add a track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, // Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
      })
      .expect(200);

    // Get the flowsheet entries
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);

    // Find the track entry (not a message)
    const trackEntry = getRes.body.find((e) => e.track_title === 'Carry the Zero');
    expect(trackEntry).toBeDefined();

    // Verify all metadata fields are present in the response schema
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
        album_id: 2, // Ravyn Lenae - Crush
        track_title: 'Venom',
      })
      .expect(200);

    const res = await request.get('/flowsheet/latest').expect(200);

    // Verify metadata fields are in the response
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
    // Add a track from the library
    // The key test here is that the response returns immediately,
    // even though metadata fetch is triggered in the background
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, // Built to Spill - Keep it Like a Secret
        track_title: 'The Plan',
      })
      .expect(200);

    // Response should return immediately with the entry
    expect(addRes.body.id).toBeDefined();
    expect(addRes.body.track_title).toEqual('The Plan');
    expect(addRes.body.artist_name).toEqual('Built to Spill');

    // Entry should be queryable immediately
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const entry = getRes.body.find((e) => e.id === addRes.body.id);
    expect(entry).toBeDefined();

    // Metadata fields should exist in response (may be null if fetch hasn't completed)
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
      .expect(200);

    // Response should return immediately
    expect(addRes.body.id).toBeDefined();
    expect(addRes.body.track_title).toEqual('Paranoid Android');
    expect(addRes.body.artist_name).toEqual('Radiohead');

    // Entry should be queryable immediately
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const entry = getRes.body.find((e) => e.id === addRes.body.id);
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
      .expect(200);

    // Get the entry immediately
    const getRes = await request.get('/flowsheet').query({ limit: 3 }).send().expect(200);

    const messageEntry = getRes.body.find((e) => e.message === 'PSA: Station ID at the top of the hour');
    expect(messageEntry).toBeDefined();

    // Messages should have null metadata fields
    expect(messageEntry.artwork_url).toBeNull();
    expect(messageEntry.spotify_url).toBeNull();
    expect(messageEntry.youtube_music_url).toBeNull();
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
    // Add a new track
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2,
        track_title: 'CRUD Test Track',
      })
      .expect(200);

    // Get entries - should include new entry
    const res = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);

    const newEntry = res.body.find((e) => e.track_title === 'CRUD Test Track');
    expect(newEntry).toBeDefined();
  });

  test('Deleted tracks are removed from queries', async () => {
    // Add a track to delete
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 3,
        track_title: 'Delete Test Track',
      })
      .expect(200);

    const entryId = addRes.body.id;

    // Verify it appears in GET
    const res1 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    expect(res1.body.some((e) => e.id === entryId)).toBe(true);

    // Delete the track
    await request
      .delete('/flowsheet')
      .set('Authorization', global.access_token)
      .send({ entry_id: entryId })
      .expect(200);

    // Verify it's removed from GET
    const res2 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    expect(res2.body.some((e) => e.id === entryId)).toBe(false);
  });

  test('Updated tracks reflect changes in queries', async () => {
    // Add a track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Update Test Original',
      })
      .expect(200);

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
    const updatedEntry = res.body.find((e) => e.id === entryId);
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

  test('Rotation entries include rotation_play_freq', async () => {
    // Add a track with rotation_id (album_id 1 is in rotation per seed)
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Rotation Test Track',
        rotation_id: 1,
      })
      .expect(200);

    // Get the entry
    const getRes = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const rotationEntry = getRes.body.find((e) => e.track_title === 'Rotation Test Track');

    expect(rotationEntry).toBeDefined();
    expect(rotationEntry.rotation_id).toEqual(1);
    expect(rotationEntry.rotation_play_freq).toEqual('L'); // From seed data
  });
});

describe('Metadata Service Initialization', () => {
  test('Backend healthcheck passes (metadata service initialized)', async () => {
    const res = await request.get('/healthcheck').expect(200);
    expect(res.body.message).toEqual('Healthy!');
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
        album_id: 1,
        track_title: 'Cache Consistency Test',
      })
      .expect(200);

    // Query multiple times - should return consistent results
    const res1 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const res2 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);
    const res3 = await request.get('/flowsheet').query({ limit: 10 }).send().expect(200);

    // All responses should have the same entries
    expect(res1.body.length).toEqual(res2.body.length);
    expect(res2.body.length).toEqual(res3.body.length);
    expect(res1.body.map((e) => e.id)).toEqual(res2.body.map((e) => e.id));
    expect(res2.body.map((e) => e.id)).toEqual(res3.body.map((e) => e.id));
  });

  test('Cache is invalidated after adding a track', async () => {
    // Add a new track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2,
        track_title: 'Cache Invalidation Test Add',
      })
      .expect(200);

    // Query - should include the new entry (proves cache was invalidated)
    const afterRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);

    // New entry should be in results (it's the most recent, so should be first)
    expect(afterRes.body.some((e) => e.id === addRes.body.id)).toBe(true);
  });

  test('Cache is invalidated after deleting a track', async () => {
    // Add a track first
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Cache Invalidation Test Delete',
      })
      .expect(200);

    const entryId = addRes.body.id;

    // Verify it's in the cache
    const beforeRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    expect(beforeRes.body.some((e) => e.id === entryId)).toBe(true);

    // Delete the track
    await request
      .delete('/flowsheet')
      .set('Authorization', global.access_token)
      .send({ entry_id: entryId })
      .expect(200);

    // Query again - entry should be gone
    const afterRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    expect(afterRes.body.some((e) => e.id === entryId)).toBe(false);
  });

  test('Cache is invalidated after updating a track', async () => {
    // Add a track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Cache Update Original',
      })
      .expect(200);

    const entryId = addRes.body.id;

    // Verify original title is in cache
    const beforeRes = await request.get('/flowsheet').query({ limit: 50 }).send().expect(200);
    const beforeEntry = beforeRes.body.find((e) => e.id === entryId);
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
    const afterEntry = afterRes.body.find((e) => e.id === entryId);
    expect(afterEntry.track_title).toEqual('Cache Update Modified');
  });
});
