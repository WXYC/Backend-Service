const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

/**
 * Integration coverage for GET /library/query — the new query-builder endpoint.
 *
 * Sibling to library.search-ranking.spec.js (which exercises the older
 * `/library/` endpoint). This one verifies the parsed-query field semantics
 * (artist:/album:/label:, NOT, quoted exact), the filter params (on_streaming,
 * genre, format), pagination + total, and validation errors.
 */
describe('GET /library/query', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('returns the response envelope shape', async () => {
    const res = await auth.get('/library/query').query({ limit: 1 }).expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        results: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        totalPages: expect.any(Number),
      })
    );
  });

  test('empty q returns a sorted page of the catalog', async () => {
    const res = await auth.get('/library/query').query({ sort: 'album', order: 'asc', limit: 5 }).expect(200);

    expect(res.body.results.length).toBeGreaterThan(0);
    const titles = res.body.results.map((r) => r.album_title);
    const sorted = [...titles].sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(sorted);
  });

  test('artist: prefix filters by artist name', async () => {
    const res = await auth.get('/library/query').query({ q: 'artist:Stereolab', limit: 10 }).expect(200);

    expect(res.body.results.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body.results) {
      expect(row.artist_name).toBe('Stereolab');
    }
  });

  test('album: prefix filters by album title', async () => {
    const res = await auth.get('/library/query').query({ q: 'album:Confield', limit: 10 }).expect(200);

    expect(res.body.results.length).toBeGreaterThan(0);
    for (const row of res.body.results) {
      expect(row.album_title.toLowerCase()).toContain('confield');
    }
  });

  test('NOT excludes matching rows', async () => {
    const baseline = await auth.get('/library/query').query({ q: 'artist:Stereolab', limit: 10 }).expect(200);
    const negated = await auth
      .get('/library/query')
      .query({ q: 'artist:Stereolab AND NOT album:"Mars Audiac Quintet"', limit: 10 })
      .expect(200);

    expect(baseline.body.results.length).toBeGreaterThan(negated.body.results.length);
    for (const row of negated.body.results) {
      expect(row.album_title).not.toBe('Mars Audiac Quintet');
    }
  });

  test('quoted value does exact match', async () => {
    const exact = await auth.get('/library/query').query({ q: 'artist:"Stereolab"', limit: 10 }).expect(200);
    expect(exact.body.results.length).toBeGreaterThan(0);
    for (const row of exact.body.results) {
      expect(row.artist_name).toBe('Stereolab');
    }
  });

  test('genre filter restricts results', async () => {
    const res = await auth.get('/library/query').query({ genre: 'Rock', limit: 50 }).expect(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const row of res.body.results) {
      expect(row.genre_name).toBe('Rock');
    }
  });

  test('format filter restricts results', async () => {
    const res = await auth.get('/library/query').query({ format: 'cd', limit: 50 }).expect(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const row of res.body.results) {
      expect(row.format_name).toBe('cd');
    }
  });

  test('stable pagination across same-primary-sort rows', async () => {
    // Sort by album asc — Stereolab's two records share artist but have
    // distinct titles, and the secondary `artist_name` sort gives the same
    // ordering across page boundaries.
    const page1 = await auth
      .get('/library/query')
      .query({ sort: 'album', order: 'asc', limit: 3, page: 0 })
      .expect(200);
    const page2 = await auth
      .get('/library/query')
      .query({ sort: 'album', order: 'asc', limit: 3, page: 1 })
      .expect(200);

    const ids1 = new Set(page1.body.results.map((r) => r.id));
    for (const row of page2.body.results) {
      expect(ids1.has(row.id)).toBe(false);
    }
    expect(page1.body.total).toBe(page2.body.total);
  });

  test('totalPages reflects total / limit', async () => {
    const res = await auth.get('/library/query').query({ limit: 1 }).expect(200);
    expect(res.body.totalPages).toBe(Math.ceil(res.body.total / 1));
  });

  test('rejects unknown genre with 400', async () => {
    const res = await auth.get('/library/query').query({ genre: 'NotARealGenre' }).expect(400);
    expect(res.body.message).toMatch(/genre/i);
  });

  test('rejects unknown format with 400', async () => {
    const res = await auth.get('/library/query').query({ format: 'NotARealFormat' }).expect(400);
    expect(res.body.message).toMatch(/format/i);
  });

  test('rejects out-of-range limit with 400', async () => {
    await auth.get('/library/query').query({ limit: 999 }).expect(400);
    await auth.get('/library/query').query({ limit: 0 }).expect(400);
  });

  test('rejects negative page with 400', async () => {
    await auth.get('/library/query').query({ page: -1 }).expect(400);
  });

  test('rejects malformed on_streaming with 400', async () => {
    await auth.get('/library/query').query({ on_streaming: 'maybe' }).expect(400);
  });

  test('rejects unknown sort with 400', async () => {
    const res = await auth.get('/library/query').query({ sort: 'banana' }).expect(400);
    expect(res.body.message).toMatch(/sort/i);
  });

  test('rejects unknown order with 400', async () => {
    const res = await auth.get('/library/query').query({ order: 'sideways' }).expect(400);
    expect(res.body.message).toMatch(/order/i);
  });
});
