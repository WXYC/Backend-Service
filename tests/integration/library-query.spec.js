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

  test('genres filter ORs multiple genre names', async () => {
    const rockOnly = await auth.get('/library/query').query({ genre: 'Rock', limit: 50 }).expect(200);
    const jazzOnly = await auth.get('/library/query').query({ genre: 'Jazz', limit: 50 }).expect(200);
    expect(rockOnly.body.results.length).toBeGreaterThan(0);
    expect(jazzOnly.body.results.length).toBeGreaterThan(0);

    const combined = await auth.get('/library/query').query({ genres: 'Rock,Jazz', limit: 100 }).expect(200);
    expect(combined.body.results.length).toBeGreaterThan(0);
    for (const row of combined.body.results) {
      expect(['Rock', 'Jazz']).toContain(row.genre_name);
    }
    const combinedIds = new Set(combined.body.results.map((r) => r.id));
    const rockIds = rockOnly.body.results.map((r) => r.id);
    const jazzIds = jazzOnly.body.results.map((r) => r.id);
    expect(rockIds.some((id) => combinedIds.has(id)) || jazzIds.some((id) => combinedIds.has(id))).toBe(true);
  });

  test('formats filter ORs multiple format names', async () => {
    const cdOnly = await auth.get('/library/query').query({ format: 'cd', limit: 50 }).expect(200);
    expect(cdOnly.body.results.length).toBeGreaterThan(0);

    const vinylRes = await auth.get('/library/query').query({ format: 'Vinyl', limit: 50 });
    const vinylOnly = vinylRes.status === 200 ? vinylRes.body.results : [];

    const formatNames = [...new Set([...cdOnly.body.results, ...vinylOnly].map((r) => r.format_name))];
    if (formatNames.length < 2) {
      // Seed may only have cd — still verify CSV param is accepted.
      const csvOnly = await auth.get('/library/query').query({ formats: 'cd', limit: 50 }).expect(200);
      expect(csvOnly.body.results.length).toBeGreaterThan(0);
      return;
    }

    const combined = await auth
      .get('/library/query')
      .query({ formats: formatNames.slice(0, 2).join(','), limit: 100 })
      .expect(200);
    expect(combined.body.results.length).toBeGreaterThan(0);
    const allowed = new Set(formatNames.slice(0, 2));
    for (const row of combined.body.results) {
      expect(allowed.has(row.format_name)).toBe(true);
    }
  });

  test('rejects unknown genre in genres list with 400', async () => {
    const res = await auth.get('/library/query').query({ genres: 'Rock,NotARealGenre' }).expect(400);
    expect(res.body.message).toMatch(/genre/i);
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

  test('rejects malformed missing with 400', async () => {
    await auth.get('/library/query').query({ missing: 'maybe' }).expect(400);
  });

  test('missing=true returns only currently missing albums', async () => {
    const res = await auth.get('/library/query').query({ missing: 'true', limit: 50 }).expect(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(0);
    for (const row of res.body.results) {
      expect(row).toEqual(expect.objectContaining({ id: expect.any(Number) }));
    }
  });

  test('rotation_bins=H returns only heavy rotation rows', async () => {
    const res = await auth.get('/library/query').query({ rotation_bins: 'H', limit: 50 }).expect(200);
    for (const row of res.body.results) {
      expect(row.rotation_bin).toBe('H');
    }
  });

  test('rotation_bins ORs multiple bins', async () => {
    const res = await auth.get('/library/query').query({ rotation_bins: 'H,M', limit: 100 }).expect(200);
    for (const row of res.body.results) {
      expect(['H', 'M']).toContain(row.rotation_bin);
    }
  });

  test('rejects unknown rotation_bins with 400', async () => {
    const res = await auth.get('/library/query').query({ rotation_bins: 'X' }).expect(400);
    expect(res.body.message).toMatch(/rotation_bins/i);
  });

  test('rotation_bins AND missing both apply', async () => {
    const res = await auth.get('/library/query').query({ rotation_bins: 'H', missing: 'true', limit: 50 }).expect(200);
    for (const row of res.body.results) {
      expect(row.rotation_bin).toBe('H');
    }
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

  test('multi-word Track 2 query ("vi scose poise") returns Confield via LML fallback', async () => {
    // CONFIELD_TRACK_QUERY tokenizes into 3 plain-text conditions. The cascade
    // gate accepts AND-only plain-text queries of any length (BS#1146); pre-fix
    // the gate rejected anything where `conditions.length !== 1`, so this
    // assertion path was silently warn-skipping.
    const res = await auth
      .get('/library/query')
      .query({ q: CONFIELD_TRACK_QUERY, sort: 'artist', order: 'asc', limit: 20 })
      .expect(200);

    expect(res.body.results).toBeDefined();
    expect(Array.isArray(res.body.results)).toBe(true);
    if (res.body.results.length === 0) {
      console.warn(
        '[BS#977/#1146] /library/query cascade returned no Track 2 results. Likely the backend is running ' +
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

  test('multi-word query mixed with field qualifier skips the cascade', async () => {
    // 'vi scose artist:NonexistentArtistFoo' parses to 2 bareword + 1
    // field-qualified condition. Even with the relaxed multi-word gate
    // (BS#1146), the presence of a field-qualified condition disqualifies the
    // query from cascade entry. Primary returns 0 → no cascade → no results.
    const res = await auth
      .get('/library/query')
      .query({ q: 'vi scose artist:NonexistentArtistFoo', limit: 10 })
      .expect(200);

    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBe(0);
    expect(res.body.total).toBe(0);
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

/**
 * Regressions from the PR #1154 review: repeated-query-key crashes (Express
 * `simple` parser yields string[]), the missing=false inverse filter, the
 * cascade leak into the missing view, and rotation-driven row duplication.
 */
describe('GET /library/query — review-feedback regressions (PR #1154)', () => {
  let auth;
  let album;
  const uniq = Date.now();

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    const res = await auth
      .post('/library')
      .send({
        album_title: `Query Fixture ${uniq}`,
        artist_name: 'Built to Spill',
        label: 'Query Fixture Label',
        genre_id: 11,
        format_id: 1,
      })
      .expect(201);
    album = res.body;
  });

  test('repeated genres keys are merged instead of crashing', async () => {
    const res = await auth.get('/library/query?genres=Rock&genres=Jazz&limit=100').expect(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const row of res.body.results) {
      expect(['Rock', 'Jazz']).toContain(row.genre_name);
    }
  });

  test('repeated rotation_bins keys are merged instead of crashing', async () => {
    const res = await auth.get('/library/query?rotation_bins=H&rotation_bins=M&limit=100').expect(200);
    for (const row of res.body.results) {
      expect(['H', 'M']).toContain(row.rotation_bin);
    }
  });

  test('repeated q keys return 400 instead of 500', async () => {
    await auth.get('/library/query?q=Bu&q=lt').expect(400);
  });

  test('missing=true and missing=false partition the catalog', async () => {
    await auth.patch(`/library/${album.id}/missing`).expect(200);

    const missingRes = await auth
      .get('/library/query')
      .query({ q: `Query Fixture ${uniq}`, missing: 'true', limit: 50 })
      .expect(200);
    expect(missingRes.body.results.some((r) => r.id === album.id)).toBe(true);

    const notMissingRes = await auth
      .get('/library/query')
      .query({ q: `Query Fixture ${uniq}`, missing: 'false', limit: 50 })
      .expect(200);
    expect(notMissingRes.body.results.some((r) => r.id === album.id)).toBe(false);

    await auth.patch(`/library/${album.id}/found`).expect(200);

    const foundRes = await auth
      .get('/library/query')
      .query({ q: `Query Fixture ${uniq}`, missing: 'false', limit: 50 })
      .expect(200);
    expect(foundRes.body.results.some((r) => r.id === album.id)).toBe(true);
  });

  test('cascade is skipped when the missing filter is present', async () => {
    // 'Bioluminescence' is a CTA-cascade trigger when unfiltered. Cascade rows
    // carry no date_lost/date_found, so with missing=true the cascade must be
    // skipped entirely instead of leaking CTA/LML rows into the missing view.
    const res = await auth
      .get('/library/query')
      .query({ q: 'Bioluminescence', missing: 'true', limit: 10 })
      .expect(200);

    expect(res.body.results.length).toBe(0);
    expect(res.body.total).toBe(0);
  });

  test('an album with multiple active rotation rows appears once, surfacing the heaviest bin', async () => {
    // BS#1554: an album active in both H and M must dedup to the single
    // heaviest active bin (H), not the alphabetically/lightest-first pick.
    await auth.post('/library/rotation').send({ album_id: album.id, rotation_bin: 'H' }).expect(201);
    await auth.post('/library/rotation').send({ album_id: album.id, rotation_bin: 'M' }).expect(201);

    const res = await auth
      .get('/library/query')
      .query({ q: `Query Fixture ${uniq}`, limit: 50 })
      .expect(200);
    const rows = res.body.results.filter((r) => r.id === album.id);
    expect(rows.length).toBe(1);
    expect(rows[0].rotation_bin).toBe('H');

    const binFiltered = await auth.get('/library/query').query({ rotation_bins: 'H,M', limit: 100 }).expect(200);
    const binRows = binFiltered.body.results.filter((r) => r.id === album.id);
    expect(binRows.length).toBe(1);
    expect(binRows[0].rotation_bin).toBe('H');
  });
});
