/**
 * Layer 3: Metadata Proxy E2E Tests
 *
 * Full E2E tests hitting Backend-Service Express endpoints via supertest.
 * Requires a running Backend-Service (with LML configured) and a running
 * better-auth service (for anonymous auth session).
 *
 * Prerequisites:
 * - Running Backend-Service (default: http://localhost:8080)
 * - Running better-auth service (default: http://localhost:8082/auth)
 * - Running LML service (LIBRARY_METADATA_URL configured in backend)
 *
 * Proxy endpoints require anonymous auth (better-auth session). The tests
 * obtain a session token via the anonymous sign-in endpoint before running.
 *
 * Run:
 *   npx jest --config jest.e2e.config.ts tests/e2e/metadata-proxy.spec.js
 */

const request = require('supertest');

const baseUrl = `${process.env.TEST_HOST || 'http://localhost'}:${process.env.PORT || 8080}`;
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || 'http://localhost:8082/auth';

let authToken = null;
let servicesReachable = false;

/**
 * Obtain an anonymous session token from better-auth.
 * Returns the bearer token string or null if auth is unavailable.
 */
async function getAnonymousToken() {
  try {
    const response = await fetch(`${BETTER_AUTH_URL}/sign-in/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) return null;

    const token = response.headers.get('set-auth-token');
    if (token) return token;

    const body = await response.json();
    return body.token || null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  // Check if Backend-Service is reachable
  try {
    const healthRes = await fetch(`${baseUrl}/healthcheck`);
    if (!healthRes.ok) {
      console.warn(`Backend-Service healthcheck failed at ${baseUrl}/healthcheck`);
      return;
    }
  } catch {
    console.warn(`Backend-Service is not reachable at ${baseUrl}`);
    return;
  }

  // Obtain anonymous auth token
  authToken = await getAnonymousToken();
  if (!authToken) {
    console.warn(
      `Could not obtain anonymous auth token from ${BETTER_AUTH_URL}. Proxy tests that require auth will be skipped.`
    );
  }

  servicesReachable = true;
});

function skipIfUnavailable() {
  if (!servicesReachable) {
    console.warn('Skipping test: Backend-Service or auth service is not reachable');
  }
}

/**
 * Helper that attaches the anonymous auth token to a supertest request.
 * Proxy endpoints require a valid better-auth session.
 */
function withAuth(req) {
  if (authToken) {
    return req.set('Authorization', `Bearer ${authToken}`);
  }
  return req;
}

describe('Metadata Proxy E2E', () => {
  describe('GET /proxy/metadata/album', () => {
    beforeEach(() => skipIfUnavailable());

    test('returns Discogs metadata for known artist and album', async () => {
      if (!servicesReachable || !authToken) return;

      const res = await withAuth(
        request(baseUrl).get('/proxy/metadata/album').query({ artistName: 'Stereolab', releaseTitle: 'Dots and Loops' })
      ).expect(200);

      expect(res.body.discogsReleaseId).toBeDefined();
      expect(typeof res.body.discogsReleaseId).toBe('number');
      expect(res.body.discogsUrl).toMatch(/discogs\.com/);
    });

    test('returns enriched fields from LML release details', async () => {
      if (!servicesReachable || !authToken) return;

      const res = await withAuth(
        request(baseUrl).get('/proxy/metadata/album').query({ artistName: 'Stereolab', releaseTitle: 'Dots and Loops' })
      ).expect(200);

      expect(res.body.releaseYear).toBeDefined();
      expect(typeof res.body.releaseYear).toBe('number');
      expect(Array.isArray(res.body.genres)).toBe(true);
      expect(res.body.genres.length).toBeGreaterThan(0);
    });

    test('returns search URLs even for unknown artists', async () => {
      if (!servicesReachable || !authToken) return;

      const res = await withAuth(
        request(baseUrl).get('/proxy/metadata/album').query({ artistName: 'xyznonexistent12345' })
      ).expect(200);

      expect(res.body.youtubeMusicUrl).toBeDefined();
      expect(res.body.bandcampUrl).toBeDefined();
      expect(res.body.discogsReleaseId).toBeUndefined();
    });

    test('returns 400 without artistName', async () => {
      if (!servicesReachable || !authToken) return;

      await withAuth(request(baseUrl).get('/proxy/metadata/album')).expect(400);
    });
  });

  describe('GET /proxy/metadata/artist', () => {
    beforeEach(() => skipIfUnavailable());

    test('returns artist bio for known Discogs ID', async () => {
      if (!servicesReachable || !authToken) return;

      const res = await withAuth(request(baseUrl).get('/proxy/metadata/artist').query({ artistId: '388' })).expect(200);

      expect(res.body.discogsArtistId).toBe(388);
      expect(typeof res.body.bio).toBe('string');
      expect(res.body.bio.length).toBeGreaterThan(0);
    });

    test('returns 400 without artistId', async () => {
      if (!servicesReachable || !authToken) return;

      await withAuth(request(baseUrl).get('/proxy/metadata/artist')).expect(400);
    });

    test('returns 400 for non-numeric artistId', async () => {
      if (!servicesReachable || !authToken) return;

      await withAuth(request(baseUrl).get('/proxy/metadata/artist').query({ artistId: 'abc' })).expect(400);
    });
  });

  describe('GET /proxy/entity/resolve', () => {
    beforeEach(() => skipIfUnavailable());

    test('resolves artist entity', async () => {
      if (!servicesReachable || !authToken) return;

      const res = await withAuth(
        request(baseUrl).get('/proxy/entity/resolve').query({ type: 'artist', id: '388' })
      ).expect(200);

      expect(res.body.name).toBe('Stereolab');
      expect(res.body.type).toBe('artist');
      expect(res.body.id).toBe(388);
    });

    test('returns 400 for missing params', async () => {
      if (!servicesReachable || !authToken) return;

      await withAuth(request(baseUrl).get('/proxy/entity/resolve').query({ type: 'artist' })).expect(400);
    });

    test('returns 400 for invalid entity type', async () => {
      if (!servicesReachable || !authToken) return;

      await withAuth(request(baseUrl).get('/proxy/entity/resolve').query({ type: 'invalid', id: '388' })).expect(400);
    });
  });
});
