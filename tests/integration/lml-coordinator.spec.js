const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous } = require('../utils/anonymous_auth');
const { isMockApiAvailable, resetMockApi, getMockRequests } = require('../utils/mock_api');

/**
 * LmlLookupCoordinator integration test (BS#885).
 *
 * Pins the central behavior of the coordinator end-to-end against the
 * backend's running API + the mock LML server: two concurrent same-key
 * `/proxy/metadata/album` requests produce ONE outbound `POST /api/v1/lookup`
 * call, not two. The coordinator's in-flight coalescing makes the second
 * request piggyback on the first request's wire call.
 *
 * Sentry span-tree shape (one `lml.lookup` span where there used to be N
 * for N coalescing callers) is verified post-deploy via the trace explorer
 * — `getActiveSpan()` returns the active span at assertion time, not a
 * historical trace, so an automated assert here would require setting up
 * the Sentry test SDK. Not worth the complexity for one acceptance test.
 */

let mockApiAvailable = false;

beforeAll(async () => {
  mockApiAvailable = await isMockApiAvailable();
  if (!mockApiAvailable) {
    console.warn('Skipping lml-coordinator tests: mock API server not available');
  }
});

describe('LmlLookupCoordinator end-to-end (Mock API)', () => {
  let anonToken;

  beforeAll(async () => {
    if (!mockApiAvailable) return;
    try {
      const { token } = await signInAnonymous();
      anonToken = token;
    } catch {
      console.warn('Could not obtain anonymous token, coordinator tests will skip');
    }
  });

  beforeEach(async () => {
    if (!mockApiAvailable) return;
    await resetMockApi();
  });

  test('two concurrent same-key /proxy/metadata/album requests coalesce to one LML lookup', async () => {
    if (!mockApiAvailable || !anonToken) return;

    // Concurrent: kick off both before awaiting either. The coordinator's
    // in-flight Map should hold both Promises before the first wire call
    // resolves.
    const [res1, res2] = await Promise.all([
      request
        .get('/proxy/metadata/album')
        .set('Authorization', `Bearer ${anonToken}`)
        .query({ artistName: 'Autechre', releaseTitle: 'Confield' }),
      request
        .get('/proxy/metadata/album')
        .set('Authorization', `Bearer ${anonToken}`)
        .query({ artistName: 'Autechre', releaseTitle: 'Confield' }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Same response from both — coalesced into one wire call.
    expect(res1.body.discogsReleaseId).toBe(res2.body.discogsReleaseId);

    // The whole point: one outbound LML lookup despite two concurrent
    // backend requests for the same (artist, album, song) key.
    const lmlRequests = await getMockRequests('lml');
    const lookupCalls = lmlRequests.filter((r) => r.path === '/api/v1/lookup');
    expect(lookupCalls.length).toBe(1);
  });

  test('different-key concurrent requests do NOT coalesce', async () => {
    if (!mockApiAvailable || !anonToken) return;

    const [res1, res2] = await Promise.all([
      request
        .get('/proxy/metadata/album')
        .set('Authorization', `Bearer ${anonToken}`)
        .query({ artistName: 'Autechre', releaseTitle: 'Confield' }),
      request
        .get('/proxy/metadata/album')
        .set('Authorization', `Bearer ${anonToken}`)
        .query({ artistName: 'Beatles', releaseTitle: 'Abbey Road' }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const lmlRequests = await getMockRequests('lml');
    const lookupCalls = lmlRequests.filter((r) => r.path === '/api/v1/lookup');
    expect(lookupCalls.length).toBe(2);
  });

  test('a settled lookup serves the next same-key request from cache (no second wire call)', async () => {
    if (!mockApiAvailable || !anonToken) return;

    // First call: warms the cache.
    const res1 = await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: 'Autechre', releaseTitle: 'Confield' })
      .expect(200);

    // Second call after the first settles: should hit the LRU cache.
    const res2 = await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: 'Autechre', releaseTitle: 'Confield' })
      .expect(200);

    expect(res2.body.discogsReleaseId).toBe(res1.body.discogsReleaseId);

    const lmlRequests = await getMockRequests('lml');
    const lookupCalls = lmlRequests.filter((r) => r.path === '/api/v1/lookup');
    expect(lookupCalls.length).toBe(1);
  });
});
