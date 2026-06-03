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
 * **Test isolation**: the coordinator's process-local LRU lives in the
 * running BS process across all integration tests, and `resetMockApi()`
 * only clears the mock-LML request log, not the coordinator's cache.
 * Each test uses uniquely-named artist keys (no overlap with other
 * integration specs that hit `/proxy/metadata/album`) so the assertions
 * on wire-call count aren't poisoned by earlier-test cache state.
 *
 * Sentry span-tree shape (one `lml.lookup` span where there used to be N
 * for N coalescing callers) is verified post-deploy via the trace explorer
 * — `getActiveSpan()` returns the active span at assertion time, not a
 * historical trace, so an automated assert here would require setting up
 * the Sentry test SDK. Not worth the complexity for one acceptance test.
 */

// Unique per-test artists. The mock LML responds with `results: []` for any
// unknown artist (still a 200 LookupResponse), which is exactly what we
// want — the test counts wire calls, not response content.
const COALESCE_ARTIST = 'BS885 Coalesce Test Artist';
const DIFFKEY_ARTIST_A = 'BS885 Diff Key Artist A';
const DIFFKEY_ARTIST_B = 'BS885 Diff Key Artist B';
const CACHE_ARTIST = 'BS885 Cache Hit Test Artist';

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
        .query({ artistName: COALESCE_ARTIST, releaseTitle: 'Test Album' }),
      request
        .get('/proxy/metadata/album')
        .set('Authorization', `Bearer ${anonToken}`)
        .query({ artistName: COALESCE_ARTIST, releaseTitle: 'Test Album' }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

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
        .query({ artistName: DIFFKEY_ARTIST_A, releaseTitle: 'Album A' }),
      request
        .get('/proxy/metadata/album')
        .set('Authorization', `Bearer ${anonToken}`)
        .query({ artistName: DIFFKEY_ARTIST_B, releaseTitle: 'Album B' }),
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
    await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: CACHE_ARTIST, releaseTitle: 'Cache Album' })
      .expect(200);

    // Second call after the first settles: should hit the LRU cache.
    await request
      .get('/proxy/metadata/album')
      .set('Authorization', `Bearer ${anonToken}`)
      .query({ artistName: CACHE_ARTIST, releaseTitle: 'Cache Album' })
      .expect(200);

    const lmlRequests = await getMockRequests('lml');
    const lookupCalls = lmlRequests.filter((r) => r.path === '/api/v1/lookup');
    expect(lookupCalls.length).toBe(1);
  });
});
