const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { isMockApiAvailable } = require('../utils/mock_api');

/**
 * Integration tests for GET /proxy/library/:libraryId/tracks (E6-5 / BS#836).
 *
 * Composes library_identity (BS PG) + LML's /api/v1/discogs/release/{id}
 * (mock LML) into the tracklist the dj-site flowsheet picker consumes.
 *
 * The library row (id=7100, legacy_release_id=65880) comes from
 * tests/fixtures/shape.sql. The mock LML's release fixture for Discogs
 * id 4080 (Confield) lives at dev_env/mock-api-server/src/fixtures/lml.json.
 * This spec seeds the missing `library_identity` row to bridge the two,
 * exercises the endpoint, and cleans up.
 */

const SHAPE_LIBRARY_ID = 7100;
const SHAPE_LEGACY_ID = 65880;
const MOCK_LML_RELEASE_ID = 4080;

// `MOCK_API_URL` is unset in environments not configured for mock-LML tests
// (so we don't intend to run them). It is set in the CI mock environment and
// in local dev_env. We use `describe.skip` on the mock-requiring block rather
// than an in-test `if (!available) return` (which silently passes — the issue
// raised in PR #922 review iteration 1).
//
// When MOCK_API_URL *is* set but unreachable, beforeAll throws and the suite
// fails loudly — that's the desired behavior: a configured-but-broken mock is
// an environment problem, not a skippable case.
const mockApiConfigured = !!process.env.MOCK_API_URL;
const describeWhenMockConfigured = mockApiConfigured ? describe : describe.skip;

describe('GET /proxy/library/:libraryId/tracks (E6-5)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
  });

  describeWhenMockConfigured('with mock LML available (composes library_identity + LML)', () => {
    beforeAll(async () => {
      if (!(await isMockApiAvailable())) {
        throw new Error('MOCK_API_URL is set but mock-api-server is unreachable; cannot run mock-LML-dependent tests');
      }
      await sql.unsafe(
        `INSERT INTO ${wxycSchema}.library_identity
           (library_id, discogs_release_id, last_verified_at, method, confidence)
         VALUES ($1, $2, NOW(), 'integration-test', 0.95)
         ON CONFLICT (library_id) DO UPDATE
           SET discogs_release_id = EXCLUDED.discogs_release_id`,
        [SHAPE_LIBRARY_ID, MOCK_LML_RELEASE_ID]
      );
    });

    afterAll(async () => {
      await sql.unsafe(`DELETE FROM ${wxycSchema}.library_identity WHERE library_id = $1`, [SHAPE_LIBRARY_ID]);
    });

    test('returns the tracklist composed from library_identity + LML when identity is resolved', async () => {
      const res = await auth.get(`/proxy/library/${SHAPE_LEGACY_ID}/tracks`).expect(200);

      expect(res.body.library_id).toBe(SHAPE_LEGACY_ID);
      expect(res.body.discogs_release_id).toBe(MOCK_LML_RELEASE_ID);
      expect(res.body.source).toBe('discogs');
      expect(Array.isArray(res.body.tracks)).toBe(true);
      expect(res.body.tracks.length).toBeGreaterThanOrEqual(1);
      res.body.tracks.forEach((t) => {
        expect(typeof t.position).toBe('string');
        expect(typeof t.title).toBe('string');
        expect(typeof t.artist_credit).toBe('string');
        expect(t.duration_ms === null || typeof t.duration_ms === 'number').toBe(true);
      });
    });
  });

  test('returns 200 + empty tracks when no library_identity exists', async () => {
    // legacy id 999_999_999 has no library row, so no identity either.
    const res = await auth.get('/proxy/library/999999999/tracks').expect(200);
    expect(res.body).toEqual({
      library_id: 999999999,
      discogs_release_id: null,
      source: null,
      tracks: [],
    });
  });

  test('returns 400 when libraryId is not a positive integer', async () => {
    const res = await auth.get('/proxy/library/not-a-number/tracks').expect(400);
    expect(res.body.message ?? res.body.error ?? '').toMatch(/positive integer/i);
  });
});
