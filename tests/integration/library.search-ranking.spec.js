const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectArray } = require('../utils/test_helpers');

/**
 * Catalog Search Ranking E2E Tests (Epic A.6)
 *
 * Verifies the new tsvector + plays Both-mode path and the trigram fallback
 * land at the HTTP boundary. The unit suite at
 * tests/unit/services/library.service.test.ts asserts the routing logic;
 * these tests assert that the seed fixture, schema, and service compose so
 * the published `/library` endpoint returns the right rows.
 *
 * Both-mode is triggered by sending the same string as `artist_name` and
 * `album_title` (the dj-site default). That is the path the new ranker
 * exists for.
 */

describe('GET /library — ranking quality (Epic A)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('Both-mode multi-word query AND-restricts to the matching album', async () => {
    // The seed has two Stereolab albums. `stereolab transient` should match
    // only the Transient-Random-Noise-Bursts row; the other Stereolab album
    // (Mars Audiac Quintet) lacks the second token and must drop out.
    const q = 'stereolab transient';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].artist_name.toLowerCase()).toContain('stereolab');
    expect(res.body[0].album_title.toLowerCase()).toContain('transient');
    // AND-semantics: Mars Audiac Quintet (no "transient" token) should not appear.
    for (const row of res.body) {
      expect(row.album_title.toLowerCase()).not.toContain('mars audiac');
    }
  });

  test('Both-mode falls back to trigram for typo-laden queries', async () => {
    // `sterolab` (one missing letter) is a trigram-distance-1 match against
    // `stereolab` and produces no tsvector hit (distinct lexeme). The
    // service must run the fallback and still return Stereolab rows.
    const q = 'sterolab';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.some((row) => row.artist_name.toLowerCase().includes('stereolab'))).toBe(true);
  });

  test('Both-mode returns empty for pure-punctuation queries', async () => {
    const q = '!!!';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBe(0);
  });

  test('result rows expose the denormalized artist_name (no view dependency)', async () => {
    // The new path reads `library.artist_name` directly. If the denorm
    // column is unpopulated for seed rows, ranking degrades to album_title
    // only — this assertion guards against that regression.
    const q = 'stereolab';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(typeof row.artist_name).toBe('string');
      expect(row.artist_name.length).toBeGreaterThan(0);
    }
  });
});
