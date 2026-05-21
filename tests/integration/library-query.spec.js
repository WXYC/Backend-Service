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

/**
 * GET /library/query — catalog-track-search cascade (BS#977).
 *
 * `searchLibraryQueryEndpoint` is what dj-site's *modern* Card Catalog calls
 * via `useCatalogQuerySearch`. Its underlying `librarySearchService.searchLibrary`
 * has its own field-aware ILIKE-based primary path that doesn't reach the
 * Track 1 (CTA) + Track 2 (LML `/lookup`) cascade owned by
 * `libraryService.searchLibraryBothMode`. That left modern dj-site without
 * `matched_via` chips even after BS#972 / #973 wired the cascade onto the
 * classic-experience `GET /library/` route.
 *
 * These cases drive the same CTA + Track 2 fixtures as the cascade describes
 * in library.spec.js, but through the `/library/query` envelope shape
 * (`{ results, total, page, totalPages }`). They follow the
 * skip-if-flag-off pattern: a 0-result response in CI means the flag isn't
 * set; the test warns and short-circuits.
 *
 * Cascade trigger is the single-bareword case (no `artist:` / `album:` /
 * `label:` qualifiers, no quoted exact, no NOT). Field-qualified queries
 * skip the cascade even on a primary 0-hit (covered below).
 */
describe('GET /library/query cascade — modern Card Catalog serves matched_via (BS#977)', () => {
  let auth;
  // CTA fixture (mirror of the BS#972 + BS#819 blocks in library.spec.js).
  const CTA_LIBRARY_ID = 7000;
  const CTA_ALBUM_TITLE = 'Shape Fixture Album Alpha 1';
  const CTA_ARTIST = 'Shape Fixture Artist Alpha';
  // Track 2 fixture (mirror of the BS#972 + BS#825 blocks in library.spec.js).
  const CONFIELD_LIBRARY_ID = 7100;
  const CONFIELD_ALBUM_TITLE = 'Confield';
  const CONFIELD_TRACK_QUERY = 'vi scose poise';

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('single-bareword CTA query returns the comp library row with matched_via.source = "cta"', async () => {
    // 'Bioluminescence' is a CTA-fixture track title that matches no library
    // artist/album/label by ILIKE, so the primary path returns 0 rows and the
    // cascade fires; the CTA layer then maps the track back to its parent
    // comp library row (CTA_LIBRARY_ID) via the curated track→album map.
    const res = await auth.get('/library/query').query({ q: 'Bioluminescence', limit: 10 }).expect(200);

    expect(res.body.results).toBeDefined();
    expect(Array.isArray(res.body.results)).toBe(true);
    if (res.body.results.length === 0) {
      console.warn(
        '[BS#977] /library/query cascade returned no results. Likely the backend is running ' +
          'without CATALOG_TRACK_SEARCH_CTA_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }

    const hit = res.body.results.find((row) => row.id === CTA_LIBRARY_ID);
    expect(hit).toBeDefined();
    expect(hit.album_title).toBe(CTA_ALBUM_TITLE);
    expect(hit.artist_name).toBe(CTA_ARTIST);
    expect(Array.isArray(hit.matched_via)).toBe(true);
    expect(hit.matched_via.length).toBeGreaterThanOrEqual(1);
    const bioHints = hit.matched_via.filter((m) => m.title === 'Bioluminescence');
    expect(bioHints.length).toBeGreaterThanOrEqual(1);
    bioHints.forEach((hint) => {
      expect(hint.source).toBe('cta');
      expect(hint.confidence).toBe(1.0);
    });
    // Cascade-fallback envelope is single-page: total reflects cascade size,
    // not the unrelated catalog total.
    expect(res.body.total).toBe(res.body.results.length);
    expect(res.body.page).toBe(0);
    expect(res.body.totalPages).toBe(1);
  });

  test('single-bareword Track 2 query ("vi scose poise") returns Confield via LML fallback', async () => {
    const res = await auth
      .get('/library/query')
      .query({ q: CONFIELD_TRACK_QUERY, sort: 'artist', order: 'asc', limit: 20 })
      .expect(200);

    expect(res.body.results).toBeDefined();
    expect(Array.isArray(res.body.results)).toBe(true);
    if (res.body.results.length === 0) {
      console.warn(
        '[BS#977] /library/query cascade returned no Track 2 results. Likely the backend is running ' +
          'without CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }

    const hit = res.body.results.find((row) => row.id === CONFIELD_LIBRARY_ID);
    expect(hit).toBeDefined();
    expect(hit.album_title).toBe(CONFIELD_ALBUM_TITLE);
    expect(Array.isArray(hit.matched_via)).toBe(true);
    expect(hit.matched_via.length).toBeGreaterThanOrEqual(1);
    // Mock LML's songLookup map returns matched_via.source = 'discogs_master'
    // for the Confield row; bridged via library.legacy_release_id back to BS.
    expect(hit.matched_via.some((m) => m.source && m.source.startsWith('discogs'))).toBe(true);
  });

  test('primary tsvector/ILIKE hit never carries matched_via (cascade only fires on primary 0-hit)', async () => {
    // 'Stereolab' is in the seed fixture and matches the primary ILIKE
    // (artist/album/label) cleanly; the cascade must NOT fire, so no row
    // can carry matched_via.
    const res = await auth.get('/library/query').query({ q: 'Stereolab', limit: 10 }).expect(200);

    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    res.body.results.forEach((row) => {
      expect(row.matched_via).toBeUndefined();
    });
  });

  test('field-qualified queries skip the cascade even on 0-hit', async () => {
    // `artist:NonexistentArtistFoo` returns 0 primary rows; because the
    // condition is field-qualified (not a single bareword), the cascade
    // must NOT fire and the envelope must report no results.
    const res = await auth.get('/library/query').query({ q: 'artist:NonexistentArtistFoo', limit: 10 }).expect(200);

    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBe(0);
    expect(res.body.total).toBe(0);
    expect(res.body.totalPages).toBe(0);
  });

  test('cascade pagination beyond page=0 returns empty results', async () => {
    // Cascade fallback is single-page; page > 0 must be empty (no offset
    // semantics over a bounded fallback list).
    const res = await auth.get('/library/query').query({ q: CONFIELD_TRACK_QUERY, page: 1, limit: 20 }).expect(200);

    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBe(0);
  });
});
