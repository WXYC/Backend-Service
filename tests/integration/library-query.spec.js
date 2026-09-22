const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

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
    // The CTA arm reaches `AlbumSearchResultRow` through raw SQL and an
    // unchecked cast, so these are the only assertions that can catch a column
    // going missing from its SELECT. The unit tests cannot: they hand their
    // mocked rows every field, so a column absent from the real SQL is
    // invisible to them. `artist_id` went missing this way (BS#2228) and the
    // three `discogs*` fields had been missing since BS#1895 (BS#2231).
    //
    // A dropped column reaches here as `undefined`, which `JSON.stringify`
    // omits — so asserting the key's presence and its value is what
    // discriminates, not the value alone. The CTA fixture is unflagged, hence
    // `false`; `flowsheet.spec.js` covers a flagged row on the mutation echo.
    expect(typeof hit.artist_id).toBe('number');
    // BS#2639, and the same class of defect as `artist_id` one line up: without
    // it a consumer holding two rows for one multi-genre artist cannot tell the
    // shelves apart, and the artist card falls back to the lowest membership.
    expect(typeof hit.genre_id).toBe('number');
    // Cascade rows reach the wire through `taggedRowToAlbumSearchResultRow` over
    // `LIBRARY_VIEW_PROJECTION_RAW`, NOT through `CATALOG_ROW_PROJECTION_COLUMNS`
    // — so this pins the cascade arm only. The primary SQL path has its own
    // assertion below; neither one covers the other.
    expect(hit).toHaveProperty('artwork_url');
    expect(hit.artwork_url === null || typeof hit.artwork_url === 'string').toBe(true);
    expect(hit).toHaveProperty('discogsUnavailable', false);
    expect(hit).toHaveProperty('discogsUnavailableNote', null);
    expect(hit).toHaveProperty('lastDiscogsRecheckAt', null);
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

  test('primary SQL path emits artwork_url on every row', async () => {
    // `artist:` is field-scoped, so it never reaches the cascade gate — these
    // rows come from `CATALOG_ROW_PROJECTION_COLUMNS` via `toAlbumSearchResultRow`,
    // the projection a dropped column would actually be dropped from. The unit
    // tests cannot catch that: they hand their mocked rows every field.
    //
    // Presence, not value. The endpoint warms artwork fire-and-forget, so a
    // fixture row can read `null` on one run and a real URL on a later one once
    // the cache-through has written. What must never vary is that the key
    // reaches the wire — absent from the SELECT it arrives `undefined`, which
    // `JSON.stringify` omits entirely.
    const res = await auth.get('/library/query').query({ q: 'artist:Stereolab', limit: 10 }).expect(200);

    expect(res.body.results.length).toBeGreaterThan(0);
    for (const row of res.body.results) {
      expect(row).toHaveProperty('artwork_url');
      expect(row.artwork_url === null || typeof row.artwork_url === 'string').toBe(true);
      // BS#2639. Value, not just presence: `genre_id` is the search row's only
      // way to name which of a multi-genre artist's shelves it belongs to, and
      // it travels a longer path than the other columns here -- it has to be
      // projected by `library_artist_view` itself (migration 0174) before
      // `CATALOG_ROW_PROJECTION_COLUMNS` can select it, so a dropped view
      // column and a dropped projection entry both land here as `undefined`.
      expect(typeof row.genre_id).toBe('number');
    }
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

describe('GET /library/query — active rotation card (BS#2476)', () => {
  let auth;
  let sql;
  const uniq = Date.now();
  // UNIQUE(bin, number): derive numbers from the same run-unique stamp the
  // titles use so a re-run against a persistent dev DB can't collide with a
  // previous run's fixture cards. Kept under int4 range (Date.now() is not).
  const cardNumber = (n) => (uniq % 1_000_000) + n;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
  });

  async function makeAlbum(title) {
    // 'Built to Spill' is in the integration seed for genre 11 — POST /library
    // resolves artist_name against existing (artist, genre) rows and 400s on
    // an unknown artist, so fixtures reuse a seeded one (same precedent as the
    // PR #1154 block above).
    const res = await auth
      .post('/library')
      .send({
        album_title: title,
        artist_name: 'Built to Spill',
        label: 'Card Fixture Label',
        genre_id: 11,
        format_id: 1,
      })
      .expect(201);
    return res.body;
  }

  async function makeCard(bin, number, name) {
    const [card] = await sql`
      INSERT INTO wxyc_schema.rotation_cards (bin, number, name)
      VALUES (${bin}, ${number}, ${name})
      RETURNING id
    `;
    return card.id;
  }

  async function findResult(query, albumId) {
    const res = await auth.get('/library/query').query(query).expect(200);
    return res.body.results.find((r) => r.id === albumId);
  }

  test('an actively-rotating release emits card', async () => {
    const album = await makeAlbum(`Card Fixture Active ${uniq}`);
    const cardId = await makeCard('H', cardNumber(1), 'Active Test Card');
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id)
      VALUES (${album.id}, 'H', ${cardId})
    `;

    const row = await findResult({ q: `Card Fixture Active ${uniq}`, limit: 50 }, album.id);
    expect(row.rotation_bin).toBe('H');
    expect(row.card).toEqual({ id: cardId, bin: 'H', number: cardNumber(1), name: 'Active Test Card' });
  });

  test('a killed row (kill_date in the past) emits neither rotation_bin nor card', async () => {
    const album = await makeAlbum(`Card Fixture Killed ${uniq}`);
    const cardId = await makeCard('M', cardNumber(2), 'Killed Test Card');
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id, kill_date)
      VALUES (${album.id}, 'M', ${cardId}, CURRENT_DATE - INTERVAL '1 day')
    `;

    const row = await findResult({ q: `Card Fixture Killed ${uniq}`, limit: 50 }, album.id);
    expect(row.rotation_bin).toBeNull();
    expect(row.card).toBeNull();
  });

  test('a row with a strictly-future kill_date is still active: emits rotation_bin and card', async () => {
    // Pins the `kill_date > CURRENT_DATE` arm of the canonical active
    // predicate (`kill_date IS NULL OR kill_date > CURRENT_DATE`) — a bin
    // about to roll is a normal state, and narrowing the JOIN to
    // `kill_date IS NULL` must fail here, not just on the NULL arm.
    const album = await makeAlbum(`Card Fixture Future Kill ${uniq}`);
    const cardId = await makeCard('M', cardNumber(3), 'Future Kill Card');
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id, kill_date)
      VALUES (${album.id}, 'M', ${cardId}, CURRENT_DATE + INTERVAL '30 days')
    `;

    const row = await findResult({ q: `Card Fixture Future Kill ${uniq}`, limit: 50 }, album.id);
    expect(row.rotation_bin).toBe('M');
    expect(row.card).toEqual({ id: cardId, bin: 'M', number: cardNumber(3), name: 'Future Kill Card' });
  });

  test('rotation_bin and card come from the same live row, not a stale killed one in another bin', async () => {
    const album = await makeAlbum(`Card Fixture Mixed ${uniq}`);
    const killedCardId = await makeCard('L', cardNumber(4), 'Stale Killed Card');
    const liveCardId = await makeCard('S', cardNumber(5), 'Live Card');
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id, kill_date)
      VALUES (${album.id}, 'L', ${killedCardId}, CURRENT_DATE - INTERVAL '1 day')
    `;
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id)
      VALUES (${album.id}, 'S', ${liveCardId})
    `;

    const row = await findResult({ q: `Card Fixture Mixed ${uniq}`, limit: 50 }, album.id);
    expect(row.rotation_bin).toBe('S');
    expect(row.card).toEqual({ id: liveCardId, bin: 'S', number: cardNumber(5), name: 'Live Card' });
  });

  test("card.bin is the card's own bin, so a rotation row pointing at another bin's card surfaces as a mismatch", async () => {
    // rotation.rotation_bin = card's bin is service-layer-enforced only
    // (BS#2472, no DB constraint): a violating row — ETL write, direct SQL
    // fix-up — must be visible on the read, not papered over by deriving
    // card.bin from the rotation row.
    const album = await makeAlbum(`Card Fixture Mismatch ${uniq}`);
    const cardId = await makeCard('M', cardNumber(6), 'Mismatched Card');
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id)
      VALUES (${album.id}, 'H', ${cardId})
    `;

    const row = await findResult({ q: `Card Fixture Mismatch ${uniq}`, limit: 50 }, album.id);
    expect(row.rotation_bin).toBe('H');
    expect(row.card).toEqual({ id: cardId, bin: 'M', number: cardNumber(6), name: 'Mismatched Card' });
  });

  test('GET /library emits the same nested card, and never the flat card_* columns', async () => {
    // The other catalog search read path (fuzzySearchLibrary →
    // serializeLibraryArtistViewEntry) must build `card` from the same
    // projection — and the flat card_id/card_bin/card_number/card_name
    // columns are undeclared in the contract, so they must not leak.
    const album = await makeAlbum(`Card Fixture Library Path ${uniq}`);
    const cardId = await makeCard('H', cardNumber(7), 'Library Path Card');
    await sql`
      INSERT INTO wxyc_schema.rotation (album_id, rotation_bin, card_id)
      VALUES (${album.id}, 'H', ${cardId})
    `;

    const q = `Card Fixture Library Path ${uniq}`;
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);
    const row = res.body.find((r) => r.id === album.id);
    expect(row.rotation_bin).toBe('H');
    expect(row.card).toEqual({ id: cardId, bin: 'H', number: cardNumber(7), name: 'Library Path Card' });
    expect(row).not.toHaveProperty('card_id');
    expect(row).not.toHaveProperty('card_bin');
    expect(row).not.toHaveProperty('card_number');
    expect(row).not.toHaveProperty('card_name');
  });
});
