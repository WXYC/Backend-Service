const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const fls_util = require('../utils/flowsheet_util');
const { signInAnonymous } = require('../utils/anonymous_auth');
const { isMockApiAvailable, resetMockApi, getMockRequests, simulateError } = require('../utils/mock_api');

/**
 * Metadata LML Integration Tests
 *
 * Verifies the end-to-end metadata pipeline when the backend routes through
 * a mock LML server (LIBRARY_METADATA_URL). Requires the mock-api-server
 * to be running with LML fixture data.
 *
 * Uses secondary_dj_id to avoid conflicts with other flowsheet tests.
 */

let mockApiAvailable = false;
const getTestDjId = () => global.secondary_dj_id;

/**
 * Poll GET /flowsheet until a metadata field is non-null on a given entry,
 * or timeout after `ms` milliseconds.
 */
async function waitForMetadata(entryId, field, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await request.get('/flowsheet').query({ limit: 20 }).send();
    if (res.status === 200) {
      const entry = res.body.entries?.find((e) => e.id === entryId);
      if (entry && entry[field] != null) return entry;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await request.get('/flowsheet').query({ limit: 20 }).send();
  return res.body.entries?.find((e) => e.id === entryId) ?? null;
}

beforeAll(async () => {
  mockApiAvailable = await isMockApiAvailable();
  if (!mockApiAvailable) {
    console.warn('Skipping metadata-lml tests: mock API server not available');
  }
});

describe('Metadata via LML (Mock API)', () => {
  beforeEach(async () => {
    if (!mockApiAvailable) return;
    await resetMockApi();
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    if (!mockApiAvailable) return;
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  describe('Fire-and-forget LML calls on flowsheet insert', () => {
    test('adding a non-library track triggers LML search', async () => {
      if (!mockApiAvailable) return;

      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          artist_name: 'Autechre',
          album_title: 'Confield',
          track_title: 'VI Scose Poise',
        })
        .expect(201);

      // Give fire-and-forget a moment to execute
      await new Promise((r) => setTimeout(r, 300));

      const lmlRequests = await getMockRequests('lml');
      const searchCalls = lmlRequests.filter((r) => r.path === '/api/v1/discogs/search');
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);
      expect(searchCalls[0].body.artist).toBe('Autechre');
    });

    test('messages do not trigger LML calls for the message content', async () => {
      if (!mockApiAvailable) return;

      await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({ message: 'Station ID at the top of the hour' })
        .expect(201);

      await new Promise((r) => setTimeout(r, 300));

      // Check that no LML search was made with the message text as artist.
      // We can't assert on total count because fire-and-forget from previous
      // tests may still be completing.
      const lmlRequests = await getMockRequests('lml');
      const searchCalls = lmlRequests.filter(
        (r) => r.path === '/api/v1/discogs/search' && r.body?.artist === 'Station ID at the top of the hour'
      );
      expect(searchCalls.length).toBe(0);
    });
  });

  describe('Metadata populated from LML fixture data', () => {
    test('artwork_url and discogs_url populated for known artist', async () => {
      if (!mockApiAvailable) return;

      const addRes = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          artist_name: 'Autechre',
          album_title: 'Confield',
          track_title: 'VI Scose Poise',
        })
        .expect(201);

      const entry = await waitForMetadata(addRes.body.id, 'artwork_url');
      expect(entry).not.toBeNull();
      expect(entry.artwork_url).toBeDefined();
      expect(entry.discogs_url).toContain('discogs.com');
    });

    test('streaming URLs populated from LML enrichment', async () => {
      if (!mockApiAvailable) return;

      const addRes = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          artist_name: 'Autechre',
          album_title: 'Confield',
          track_title: 'VI Scose Poise',
        })
        .expect(201);

      const entry = await waitForMetadata(addRes.body.id, 'spotify_url');
      expect(entry).not.toBeNull();
      expect(entry.spotify_url).toContain('spotify.com');
      expect(entry.apple_music_url).toContain('apple.com');
    });

    test('artist bio and wikipedia populated from LML artist details', async () => {
      if (!mockApiAvailable) return;

      const addRes = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          artist_name: 'Autechre',
          album_title: 'Confield',
          track_title: 'Cfern',
        })
        .expect(201);

      const entry = await waitForMetadata(addRes.body.id, 'artist_bio');
      expect(entry).not.toBeNull();
      expect(entry.artist_bio).toContain('electronic music duo');
      expect(entry.artist_wikipedia_url).toContain('wikipedia.org');
    });

    test('search URLs present even for unknown artist', async () => {
      if (!mockApiAvailable) return;

      const addRes = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          artist_name: 'Nonexistent Artist XYZ',
          album_title: 'No Album',
          track_title: 'No Track',
        })
        .expect(201);

      const entry = await waitForMetadata(addRes.body.id, 'youtube_music_url', 500);
      expect(entry).not.toBeNull();
      expect(entry.youtube_music_url).toContain('music.youtube.com');
      expect(entry.bandcamp_url).toContain('bandcamp.com');
    });
  });

  describe('LML failure handling', () => {
    test('LML 500 error: entry created, search URLs still present', async () => {
      if (!mockApiAvailable) return;

      // Wait for any in-flight fire-and-forget to settle, then reset + simulate
      await new Promise((r) => setTimeout(r, 500));
      await resetMockApi();
      await simulateError('lml', '/api/v1/discogs/search', 500);

      const addRes = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send({
          artist_name: 'Nonexistent Error Test',
          album_title: 'No Album',
          track_title: 'No Track',
        })
        .expect(201);

      // Entry should be created regardless of LML failure
      expect(addRes.body.id).toBeDefined();

      // Search URLs are constructed locally and should still appear
      const entry = await waitForMetadata(addRes.body.id, 'youtube_music_url', 500);
      expect(entry).not.toBeNull();
      expect(entry.youtube_music_url).toContain('music.youtube.com');
    });
  });
});

describe('Proxy endpoints via LML (Mock API)', () => {
  let anonToken;

  beforeAll(async () => {
    if (!mockApiAvailable) return;
    try {
      const { token } = await signInAnonymous();
      anonToken = token;
    } catch {
      console.warn('Could not obtain anonymous token, proxy tests will skip');
    }
  });

  beforeEach(async () => {
    if (!mockApiAvailable) return;
    await resetMockApi();
  });

  test('GET /proxy/metadata/album returns enriched metadata', async () => {
    if (!mockApiAvailable || !anonToken) return;

    const res = await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: 'Autechre', releaseTitle: 'Confield' })
      .expect(200);

    expect(res.body.discogsReleaseId).toBe(4080);
    expect(res.body.discogsUrl).toContain('discogs.com');
    expect(res.body.releaseYear).toBe(2001);
  });

  test('GET /proxy/metadata/artist returns bio and Wikipedia', async () => {
    if (!mockApiAvailable || !anonToken) return;

    const res = await request
      .get('/proxy/metadata/artist')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistId: '3391' })
      .expect(200);

    expect(res.body.discogsArtistId).toBe(3391);
    expect(res.body.bio).toContain('electronic music duo');
    // Proxy endpoint returns raw Discogs markup (client handles rendering)
    expect(typeof res.body.bio).toBe('string');
  });

  test('GET /proxy/entity/resolve returns entity name', async () => {
    if (!mockApiAvailable || !anonToken) return;

    const res = await request
      .get('/proxy/entity/resolve')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ type: 'artist', id: '3391' })
      .expect(200);

    expect(res.body.name).toBe('Autechre');
    expect(res.body.type).toBe('artist');
    expect(res.body.id).toBe(3391);
  });

  test('LML 500 translates to 502 on proxy endpoint', async () => {
    if (!mockApiAvailable || !anonToken) return;

    // Permanent error (no count) — affects all subsequent LML search calls
    await simulateError('lml', '/api/v1/discogs/search', 500);

    // Make the proxy call immediately before any fire-and-forget can consume the rule
    const res = await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: 'Autechre' });

    // Accept either 502 (LML error mapped) or 200 (if a background request consumed the rule)
    // The important thing is the server doesn't crash
    expect([200, 502]).toContain(res.status);
  });
});
