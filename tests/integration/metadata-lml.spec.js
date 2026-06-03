const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous } = require('../utils/anonymous_auth');
const { isMockApiAvailable, resetMockApi, simulateError } = require('../utils/mock_api');

/**
 * Proxy LML Integration Tests
 *
 * Verifies the iOS proxy path through the backend's `proxy.controller` to a
 * mock LML server (LIBRARY_METADATA_URL). Requires the mock-api-server to be
 * running with LML fixture data.
 *
 * The historical flowsheet-insert enrichment specs that used to live here
 * exercised the inline fire-and-forget path; they were removed in #894 once
 * the CDC consumer worker (`apps/enrichment-worker/`) became the canonical
 * enrichment path. Worker behavior is covered by the unit suites under
 * `tests/unit/apps/enrichment-worker/` and `tests/unit/services/`.
 */

let mockApiAvailable = false;

beforeAll(async () => {
  mockApiAvailable = await isMockApiAvailable();
  if (!mockApiAvailable) {
    console.warn('Skipping metadata-lml tests: mock API server not available');
  }
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

  test('LML 500 falls back to synthesized search URLs on /proxy/metadata/album', async () => {
    if (!mockApiAvailable || !anonToken) return;

    // Permanent error (no count) — affects all subsequent LML search calls.
    await simulateError('lml', '/api/v1/lookup', 500);

    const res = await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: 'Autechre' })
      .expect(200);

    // SearchUrlProvider-backed fallback (BS#889 + BS#1185) — when LML lookup
    // fails, the endpoint still returns 200 with synthesized service URLs so
    // iOS doesn't show greyed buttons.
    expect(res.body.youtubeMusicUrl).toContain('music.youtube.com');
    expect(res.body.bandcampUrl).toContain('bandcamp.com');
    expect(res.body.soundcloudUrl).toContain('soundcloud.com');
  });
});
