const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains, expectFields, expectArray } = require('../utils/test_helpers');

/**
 * Library Endpoints Integration Tests
 *
 * Tests for:
 * - GET /library - Fuzzy search for albums
 * - POST /library - Add album to library
 * - GET /library/rotation - Get active rotations
 * - POST /library/rotation - Add album to rotation
 * - PATCH /library/rotation - Kill rotation entry
 * - POST /library/artists - Add artist
 * - GET /library/formats - Get all formats
 * - POST /library/formats - Add format
 * - GET /library/genres - Get all genres
 * - POST /library/genres - Add genre
 * - GET /library/info - Get album info
 */

describe('Library Catalog', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library (Fuzzy Search)', () => {
    test('searches by artist name', async () => {
      const res = await auth.get('/library').query({ artist_name: 'Built to Spill' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('searches by album title', async () => {
      const res = await auth.get('/library').query({ album_title: 'Keep it Like a Secret' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('searches by both artist and album', async () => {
      const res = await auth
        .get('/library')
        .query({ artist_name: 'Built to Spill', album_title: 'Keep it' })
        .expect(200);

      expectArray(res);
    });

    test('limits results with n parameter', async () => {
      const res = await auth.get('/library').query({ artist_name: 'a', n: 3 }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeLessThanOrEqual(3);
    });

    test('returns 400 when no search parameters provided', async () => {
      const res = await auth.get('/library').expect(400);

      expectErrorContains(res, 'Missing query parameter');
    });

    test('returns empty array when no results found', async () => {
      const res = await auth.get('/library').query({ artist_name: 'xyznonexistentartist123' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBe(0);
    });

    test('code lookup returns 501 (not implemented)', async () => {
      const res = await auth.get('/library').query({ code_letters: 'BUI', code_artist_number: '1' }).expect(501);

      expectErrorContains(res, 'TODO');
    });

    test('returns nested reconciled_identity (no flat external-ID columns)', async () => {
      const res = await auth.get('/library').query({ artist_name: 'Built to Spill' }).expect(200);

      expectArray(res);
      // Built to Spill is in the seed fixture, so an empty result here means a
      // schema/seed regression rather than a missing-shape test.
      expect(res.body.length).toBeGreaterThan(0);
      const row = res.body[0];
      expect(row).toHaveProperty('reconciled_identity');
      expect(row).not.toHaveProperty('discogs_artist_id');
      expect(row).not.toHaveProperty('musicbrainz_artist_id');
      expect(row).not.toHaveProperty('wikidata_qid');
      expect(row).not.toHaveProperty('spotify_artist_id');
      expect(row).not.toHaveProperty('apple_music_artist_id');
      expect(row).not.toHaveProperty('bandcamp_id');
    });
  });

  describe('POST /library (Add Album)', () => {
    test('adds album with existing artist_name', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: `Test Album ${Date.now()}`,
          artist_name: 'Built to Spill',
          label: 'Test Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(201);

      expectFields(res.body, 'id', 'album_title');
      expect(res.body.album_title).toContain('Test Album');
    });

    test('returns 400 when album_title is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          artist_id: 1,
          label: 'Test Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when label is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          artist_id: 1,
          genre_id: 11,
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when genre_id is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          artist_id: 1,
          label: 'Test Label',
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when format_id is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          artist_id: 1,
          label: 'Test Label',
          genre_id: 11,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when neither artist_id nor artist_name provided', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          label: 'Test Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });
  });
});

describe('Library Rotation', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/rotation', () => {
    test('returns rotation as an array', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      expectArray(res);
    });

    test('rotation entries have expected fields', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      if (res.body.length > 0) {
        expectFields(
          res.body[0],
          'id',
          'artist_name',
          'alphabetical_name',
          'album_title',
          'rotation_bin',
          'rotation_id'
        );
      }
    });

    test('rotation entries return nested reconciled_identity (no flat external-ID columns)', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      if (res.body.length > 0) {
        const row = res.body[0];
        expect(row).toHaveProperty('reconciled_identity');
        expect(row).not.toHaveProperty('discogs_artist_id');
        expect(row).not.toHaveProperty('musicbrainz_artist_id');
        expect(row).not.toHaveProperty('wikidata_qid');
        expect(row).not.toHaveProperty('spotify_artist_id');
        expect(row).not.toHaveProperty('apple_music_artist_id');
        expect(row).not.toHaveProperty('bandcamp_id');
      }
    });

    // The shape fixture (tests/fixtures/shape.sql, BS#701) seeds 3 duplicate
    // active rotation groups + 2 NULL-album_id rows. The next two tests
    // assert the read-side fix for #694 (dedup) + #689 (NULL-album surface).

    test('collapses duplicate active rows per (album_id, rotation_bin) to one (#694)', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      // Group fixture rotation rows by (album_id, rotation_bin) for the
      // shape-fixture albums (id range 7000-7099). Each group should
      // resolve to exactly one row in the response.
      const fixtureRows = res.body.filter((r) => r.id !== null && r.id >= 7000 && r.id < 7100);
      const groups = new Map();
      for (const row of fixtureRows) {
        const key = `${row.id}|${row.rotation_bin}`;
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      for (const [key, count] of groups.entries()) {
        expect({ key, count }).toEqual({ key, count: 1 });
      }

      // Specifically: album 7000 in bin 'H' had 3 active rows in the
      // fixture; assert the response has exactly one entry with the
      // most-recent rotation_add_date.
      const album7000H = res.body.filter((r) => r.id === 7000 && r.rotation_bin === 'H');
      expect(album7000H).toHaveLength(1);
      expect(album7000H[0].rotation_add_date).toBe('2024-08-22');
    });

    test('surfaces rotation rows with NULL album_id using denormalized snapshot fields (#689)', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      // The shape fixture seeds NULL-album rotation rows that all start
      // with 'Shape Fixture Orphan' in artist_name. After #862's hash-
      // partitioned dedup, the two rows in Orphan One's (artist, album,
      // bin) group collapse to one, leaving 2 distinct fixture orphans.
      const orphans = res.body.filter((r) => r.id === null);
      expect(orphans.length).toBeGreaterThanOrEqual(2);

      const fixtureOrphans = orphans.filter((r) => r.artist_name && r.artist_name.startsWith('Shape Fixture Orphan'));
      expect(fixtureOrphans).toHaveLength(2);

      const orphanOne = fixtureOrphans.find((r) => r.artist_name === 'Shape Fixture Orphan One');
      expect(orphanOne).toBeDefined();
      expect(orphanOne).toMatchObject({
        id: null,
        artist_name: 'Shape Fixture Orphan One',
        album_title: 'Shape Fixture Orphan Album One',
        rotation_bin: 'L',
      });

      const orphanTwo = fixtureOrphans.find((r) => r.artist_name === 'Shape Fixture Orphan Two');
      expect(orphanTwo).toBeDefined();
      expect(orphanTwo).toMatchObject({
        id: null,
        artist_name: 'Shape Fixture Orphan Two',
        album_title: 'Shape Fixture Orphan Album Two',
        rotation_bin: 'M',
      });
    });

    test('collapses NULL-album rows sharing (artist, album, rotation_bin) to one (#862)', async () => {
      // The shape fixture seeds two NULL-album_id rotation rows (ids
      // 7007 and 7015) with identical artist/album/bin. The pre-#862
      // partition key was `coalesce(album_id, -id)`, which was unique
      // per row and let both survive DISTINCT ON; the hash partition
      // key collapses them to a single row. Pick the most-recently
      // added (rotation_add_date '2024-09-12' from row 7015) per the
      // ORDER BY add_date DESC, id ASC.
      const res = await auth.get('/library/rotation').expect(200);

      const orphanOneRows = res.body.filter(
        (r) => r.id === null && r.artist_name === 'Shape Fixture Orphan One' && r.rotation_bin === 'L'
      );
      expect(orphanOneRows).toHaveLength(1);
      expect(orphanOneRows[0].rotation_add_date).toBe('2024-09-12');
    });
  });

  describe('POST /library/rotation', () => {
    test('adds album to rotation', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({
          album_id: 2,
          rotation_bin: 'M',
        })
        .expect(201);

      expectFields(res.body, 'id', 'album_id', 'rotation_bin');
      expect(res.body.album_id).toBe(2);
      expect(res.body.rotation_bin).toBe('M');

      // Clean up
      if (res.body.id) {
        await auth.patch('/library/rotation').send({ rotation_id: res.body.id });
      }
    });

    test('returns 400 when album_id is missing', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({
          rotation_bin: 'M',
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when rotation_bin is missing', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({
          album_id: 2,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });
  });

  describe('PATCH /library/rotation (Kill Rotation)', () => {
    let testRotationId;

    beforeEach(async () => {
      const res = await auth.post('/library/rotation').send({
        album_id: 3,
        rotation_bin: 'L',
      });

      if (res.body && res.body.id) {
        testRotationId = res.body.id;
      }
    });

    test('kills rotation with default date', async () => {
      if (!testRotationId) {
        console.log('Skipping test - no rotation ID available');
        return;
      }

      const res = await auth.patch('/library/rotation').send({ rotation_id: testRotationId }).expect(200);

      expectFields(res.body, 'id', 'kill_date');
      expect(res.body.id).toBe(testRotationId);
    });

    test('kills rotation with specific date', async () => {
      const createRes = await auth.post('/library/rotation').send({
        album_id: 3,
        rotation_bin: 'H',
      });

      if (createRes.body && createRes.body.id) {
        const killDate = '2025-12-31';
        const res = await auth
          .patch('/library/rotation')
          .send({
            rotation_id: createRes.body.id,
            kill_date: killDate,
          })
          .expect(200);

        expect(res.body.kill_date).toBe(killDate);
      }
    });

    test('returns 400 when rotation_id is missing', async () => {
      const res = await auth.patch('/library/rotation').send({}).expect(400);

      expectErrorContains(res, 'Missing Parameter');
    });

    test('returns 400 with invalid date format', async () => {
      const res = await auth
        .patch('/library/rotation')
        .send({
          rotation_id: 1,
          kill_date: '12/31/2025',
        })
        .expect(400);

      expectErrorContains(res, 'Incorrect Date Format');
    });
  });
});

describe('Library Artists', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('POST /library/artists', () => {
    test('adds new artist', async () => {
      const uniqueSuffix = Date.now().toString(36).toUpperCase().slice(-2);
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: `Test Artist ${uniqueSuffix}`,
          code_letters: uniqueSuffix,
          genre_id: 11,
          code_number: 1,
        })
        .expect(201);

      expectFields(res.body, 'id', 'artist_name', 'alphabetical_name', 'code_letters', 'code_number');
      expect(res.body.artist_name).toContain('Test Artist');
      expect(res.body.alphabetical_name).toBeDefined();
      expect(res.body.code_letters).toBe(uniqueSuffix);
      // A freshly inserted artist has no resolved external IDs, so the
      // nested ReconciledIdentity is null. The flat external-ID columns are
      // not exposed on the wire — they're only accessible via the nested form.
      expect(res.body.reconciled_identity).toBeNull();
      expect(res.body).not.toHaveProperty('discogs_artist_id');
      expect(res.body).not.toHaveProperty('musicbrainz_artist_id');
    });

    test('returns 400 when artist_name is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          code_letters: 'TS',
          genre_id: 11,
          code_number: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });

    test('returns 400 when code_letters is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: 'Test Artist',
          genre_id: 11,
          code_number: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });

    test('returns 400 when genre_id is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: 'Test Artist',
          code_letters: 'TS',
          code_number: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });

    test('returns 400 when code_number is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: 'Test Artist',
          code_letters: 'TS',
          genre_id: 11,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });

    test('accepts optional alphabetical_name and returns it', async () => {
      const uniqueSuffix = Date.now().toString(36).toUpperCase().slice(-3);
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: `The Band ${uniqueSuffix}`,
          alphabetical_name: `Band ${uniqueSuffix}, The`,
          code_letters: uniqueSuffix,
          genre_id: 11,
          code_number: 1,
        })
        .expect(201);

      expect(res.body.alphabetical_name).toBe(`Band ${uniqueSuffix}, The`);
    });
  });
});

/**
 * Catalog Track Search — CTA fallback (BS#819, plan §4.1 + §9.2).
 *
 * Exercises the Track 1 (`compilation_track_artist`) fallback in
 * `searchLibrary`. When the primary tsvector + trigram path returns 0 hits
 * AND `CATALOG_TRACK_SEARCH_CTA_ENABLED=true` is set on the backend, the
 * cascade probes CTA via ILIKE on `track_title` / `artist_name` and returns
 * the matched library row with `matched_via.source = 'cta'` + `confidence: 1.0`.
 *
 * Seed: 3 CTA rows in `tests/fixtures/shape.sql` pointing at library_id 7000
 * (Shape Fixture Album Alpha 1). Track titles ('Bioluminescence',
 * 'Echolocation Hymn') are unique tokens that don't appear in any seeded
 * library row's album_title/artist_name, so the primary path can't satisfy
 * the query and short-circuit the cascade.
 *
 * Backend flag gating: these tests follow the rateLimiting.spec.js
 * skip-if-off pattern. `dev_env/docker-compose.yml` sets the flag to true
 * for `ci:testmock`; local runs need to start the backend with
 * `CATALOG_TRACK_SEARCH_CTA_ENABLED=true` in `.env` for the cases to fire.
 */
describe('Library Catalog Track Search (CTA fallback)', () => {
  let auth;
  const postgres = require('postgres');
  let sql;
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  // Match the shape-fixture seeding so the assertion below describes what's
  // expected on a fresh schema. The CTA fixture rows live in
  // tests/fixtures/shape.sql (BS#819 block).
  const SHAPE_FIXTURE_LIBRARY_ID = 7000;
  const SHAPE_FIXTURE_ALBUM_TITLE = 'Shape Fixture Album Alpha 1';
  const SHAPE_FIXTURE_ARTIST = 'Shape Fixture Artist Alpha';

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  test('CTA fixture rows are present in compilation_track_artist (sanity)', async () => {
    const rows = await sql.unsafe(
      `SELECT id, library_id, artist_name, track_title
         FROM ${schema}.compilation_track_artist
        WHERE id BETWEEN 7000 AND 7099
        ORDER BY id`
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.library_id === SHAPE_FIXTURE_LIBRARY_ID)).toBe(true);
    const titles = rows.map((r) => r.track_title);
    expect(titles).toEqual(expect.arrayContaining(['Bioluminescence', 'Echolocation Hymn']));
  });

  /**
   * The free-text cascade lives behind GET /library/search, not GET /library.
   * GET /library calls `fuzzySearchLibrary` (artist-/title-only fuzzy match);
   * /library/search calls `searchLibrary`, which is the function that runs the
   * tsvector → trigram → CTA → LML cascade. Response shape:
   * `{ success, results, total, query }`, with `results` as `EnrichedLibraryResult[]`.
   */
  test('track-title query returns the comp library row via CTA fallback', async () => {
    // 'Bioluminescence' appears only on CTA rows for library_id 7000. No
    // library row's album_title / artist_name contains it, so the primary
    // tsvector + trigram path returns 0 and the CTA fallback fires.
    const res = await auth.get('/library/search').query({ query: 'Bioluminescence' });

    if (res.status === 200 && Array.isArray(res.body.results) && res.body.results.length === 0) {
      // Backend is running without the CTA flag set; warn so the operator
      // notices. The "fixture present" sanity test already passed, so the
      // seed is correct.
      console.warn(
        '[BS#819] CTA fallback returned no results. Likely the backend is running ' +
          'without CATALOG_TRACK_SEARCH_CTA_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    const hit = res.body.results.find((row) => row.id === SHAPE_FIXTURE_LIBRARY_ID);
    expect(hit).toBeDefined();
    expect(hit.title).toBe(SHAPE_FIXTURE_ALBUM_TITLE);
    expect(hit.artist).toBe(SHAPE_FIXTURE_ARTIST);
  });

  test('CTA hit carries matched_via.source = "cta" and confidence = 1.0', async () => {
    const res = await auth.get('/library/search').query({ query: 'Bioluminescence' });

    if (res.status === 200 && Array.isArray(res.body.results) && res.body.results.length === 0) {
      console.warn('[BS#819] CTA fallback returned no results; see prior test for hint.');
      return;
    }

    expect(res.status).toBe(200);
    const hit = res.body.results.find((row) => row.id === SHAPE_FIXTURE_LIBRARY_ID);
    expect(hit).toBeDefined();
    expect(Array.isArray(hit.matched_via)).toBe(true);
    expect(hit.matched_via.length).toBeGreaterThanOrEqual(1);
    // Two CTA rows have track_title = 'Bioluminescence' (different artists).
    // The CTA grouping in searchLibraryByCTA collapses both into the same
    // EnrichedLibraryResult with one TrackMatchHint per matched CTA row.
    const bioHints = hit.matched_via.filter((m) => m.title === 'Bioluminescence');
    expect(bioHints.length).toBeGreaterThanOrEqual(2);
    bioHints.forEach((hint) => {
      expect(hint.source).toBe('cta');
      expect(hint.confidence).toBe(1.0);
      expect(hint.artist_credit).toMatch(/^Shape Fixture Comp Guest /);
    });
  });

  test('compilation row excluded from Track 2 fallback (dedup precondition)', async () => {
    // Track 2 (`searchLibraryByTrack`) excludes CTA-covered library rows via
    // the SQL at apps/backend/services/library.service.ts ~L956-973:
    //
    //   SELECT library_id FROM compilation_track_artist
    //    WHERE library_id IN (<LML candidates>)
    //      AND track_title ILIKE %query%
    //
    // The full cascade short-circuits before Track 2 fires whenever CTA
    // returns results, so the dedup is only directly observable by running
    // the precondition SELECT against the real DB. This test does both:
    //
    //   1. Run the exact CTA-exclusion SELECT against the seeded fixture
    //      and assert library_id 7000 is in the "to exclude" set.
    //   2. Verify the user-observable shape: even though library_id 7000
    //      would be a candidate for both Track 1 (CTA) and Track 2 (LML),
    //      the cascade returns it exactly once.
    const libraryCandidates = [SHAPE_FIXTURE_LIBRARY_ID];
    const dedupQuery = 'Bioluminescence';
    const ctaCovered = await sql.unsafe(
      `SELECT library_id FROM ${schema}.compilation_track_artist
        WHERE library_id = ANY($1::int[])
          AND track_title ILIKE $2`,
      [libraryCandidates, `%${dedupQuery}%`]
    );
    expect(ctaCovered.map((r) => r.library_id)).toContain(SHAPE_FIXTURE_LIBRARY_ID);

    const res = await auth.get('/library/search').query({ query: 'Bioluminescence' });
    if (res.status === 200 && Array.isArray(res.body.results) && res.body.results.length === 0) {
      console.warn('[BS#819] CTA fallback returned no results; see earlier test for hint.');
      return;
    }
    expect(res.status).toBe(200);
    const matches = res.body.results.filter((row) => row.id === SHAPE_FIXTURE_LIBRARY_ID);
    expect(matches).toHaveLength(1);
  });
});

/**
 * Catalog Track Search — Discogs cross-ref fallback (BS#825, plan §3.2 / §4.2).
 *
 * Exercises the Track 2 (`searchLibraryByTrack`) fallback in `searchLibrary`.
 * When the primary tsvector + trigram path AND the Track 1 CTA fallback both
 * return 0 hits, AND `CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true` is set on
 * the backend, the cascade calls LML's `/api/v1/lookup` song-only path
 * (`lookupBySong`) and bridges each `library_item.id` →
 * `library.legacy_release_id` → BS `library.id`.
 *
 * Fixture wiring (shared with `tests/fixtures/track-search.fixture.ts`):
 *  - Library rows seeded in `tests/fixtures/shape.sql` (Track 2 block) with
 *    `legacy_release_id` ∈ {65880, 65881, 65882}.
 *  - Mock LML's `songLookup` map in
 *    `dev_env/mock-api-server/src/fixtures/lml.json` returns each
 *    `library_item.id` with a per-source `matched_via` hint:
 *      "vi scose poise"      → discogs_master (Confield, 65880, lib 7100)
 *      "xqfp7k zelmpo b3nvh4" → discogs_release (synthetic, 65881, lib 7101)
 *      "wbtr2x cmprs 9azn5"   → discogs_master (CTA collision, 65882, lib 7102)
 *  - CTA seed in shape.sql also points at library 7102 for the CTA-collision
 *    query, so Track 1 wins and Track 2's CTA-exclusion SELECT can be
 *    asserted against the seeded data.
 *
 * Backend flag gating mirrors the BS#819 / CTA pattern:
 * `dev_env/docker-compose.yml` sets `CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true`
 * for the CI backend so `ci:testmock` exercises Track 2 end-to-end; local
 * dev runs need the flag in `.env` for the cases to fire. Each test follows
 * the skip-if-off pattern: when the cascade returns 0 hits (the flag-off
 * shape), the test warns and short-circuits rather than fails.
 */
describe('Library Catalog Track Search (Discogs cross-ref fallback)', () => {
  let auth;
  const postgres = require('postgres');
  let sql;
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  // Mirror of tests/fixtures/track-search.fixture.ts. Constants are duplicated
  // here because the integration suite is plain JS (no ts-jest transform on
  // jest.config.json) and can't `require` a .ts file at runtime. The TS file
  // is the documented source of truth; update both in lockstep.
  const CONFIELD = {
    libraryId: 7100,
    legacyReleaseId: 65880,
    albumTitle: 'Confield',
    artistName: 'Autechre',
  };
  const DIRECT_RELEASE = {
    libraryId: 7101,
    legacyReleaseId: 65881,
    albumTitle: 'Synth Bayou Quarterly',
    artistName: 'Liminal Cartographer',
  };
  const CTA_COLLISION = {
    libraryId: 7102,
    legacyReleaseId: 65882,
    albumTitle: 'Polychrome Aviary',
  };
  const QUERIES = {
    CONFIELD_TRACK: 'vi scose poise',
    DIRECT_RELEASE_TRACK: 'xqfp7k zelmpo b3nvh4',
    CTA_COLLISION_TRACK: 'wbtr2x cmprs 9azn5',
  };

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  test('Track 2 fixture library rows are present and linked to the right legacy_release_ids (sanity)', async () => {
    const rows = await sql.unsafe(
      `SELECT id, legacy_release_id, album_title, artist_name
         FROM ${schema}.library
        WHERE id IN (${CONFIELD.libraryId}, ${DIRECT_RELEASE.libraryId}, ${CTA_COLLISION.libraryId})
        ORDER BY id`
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.legacy_release_id)).toEqual([
      CONFIELD.legacyReleaseId,
      DIRECT_RELEASE.legacyReleaseId,
      CTA_COLLISION.legacyReleaseId,
    ]);
    expect(rows.map((r) => r.album_title)).toEqual([
      CONFIELD.albumTitle,
      DIRECT_RELEASE.albumTitle,
      CTA_COLLISION.albumTitle,
    ]);
  });

  test('"vi scose poise" returns Confield via discogs_master Track 2 hit', async () => {
    // No seeded library row's album_title or artist_name contains the phrase
    // "vi scose poise", and no CTA row's track_title / artist_name does
    // either, so the cascade must pass through Track 1 (CTA) and land on
    // Track 2 (LML). The mock LML's songLookup map returns
    // library_item.id=65880 with matched_via.source="discogs_master", which
    // searchLibraryByTrack bridges back to BS library.id=7100.
    const res = await auth.get('/library/search').query({ query: QUERIES.CONFIELD_TRACK });

    if (res.status === 200 && Array.isArray(res.body.results) && res.body.results.length === 0) {
      console.warn(
        '[BS#825] Track 2 fallback returned no results. Likely the backend is running ' +
          'without CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    const hit = res.body.results.find((row) => row.id === CONFIELD.libraryId);
    expect(hit).toBeDefined();
    expect(hit.title).toBe(CONFIELD.albumTitle);
    expect(hit.artist).toBe(CONFIELD.artistName);
    expect(Array.isArray(hit.matched_via)).toBe(true);
    expect(hit.matched_via.length).toBeGreaterThanOrEqual(1);
    expect(hit.matched_via[0].source).toBe('discogs_master');
  });

  test('direct-release CEI query carries matched_via.source = "discogs_release"', async () => {
    // Synthetic query keyed to the mock LML's `songLookup` entry whose
    // matched_via.source is discogs_release (vs discogs_master). Asserts
    // BS forwards LML's matched_via verbatim — Backend does not rewrite the
    // per-source provenance.
    const res = await auth.get('/library/search').query({ query: QUERIES.DIRECT_RELEASE_TRACK });

    if (res.status === 200 && Array.isArray(res.body.results) && res.body.results.length === 0) {
      console.warn('[BS#825] Track 2 fallback returned no results; see prior test for hint.');
      return;
    }

    expect(res.status).toBe(200);
    const hit = res.body.results.find((row) => row.id === DIRECT_RELEASE.libraryId);
    expect(hit).toBeDefined();
    expect(hit.title).toBe(DIRECT_RELEASE.albumTitle);
    expect(hit.artist).toBe(DIRECT_RELEASE.artistName);
    expect(Array.isArray(hit.matched_via)).toBe(true);
    expect(hit.matched_via.length).toBeGreaterThanOrEqual(1);
    expect(hit.matched_via[0].source).toBe('discogs_release');
  });

  test('CTA-covered library row is not re-emitted via Track 2 (dedup precondition)', async () => {
    // The CTA collision query matches both a CTA row (Track 1) and the mock
    // LML's songLookup (Track 2) for library_id=7102. The cascade
    // short-circuits at Track 1 whenever CTA returns results, so the
    // user-observable shape is: exactly one result, sourced from CTA. The
    // Track 2 exclusion SELECT in searchLibraryByTrack
    // (apps/backend/services/library.service.ts) is the durable fix — this
    // test exercises both the precondition SELECT and the user-facing
    // behavior, mirroring the BS#819 / CTA dedup precondition test.
    const dedupQuery = QUERIES.CTA_COLLISION_TRACK;
    const ctaCovered = await sql.unsafe(
      `SELECT library_id FROM ${schema}.compilation_track_artist
        WHERE library_id = ANY($1::int[])
          AND track_title ILIKE $2`,
      [[CTA_COLLISION.libraryId], `%${dedupQuery}%`]
    );
    expect(ctaCovered.map((r) => r.library_id)).toContain(CTA_COLLISION.libraryId);

    const res = await auth.get('/library/search').query({ query: dedupQuery });
    if (res.status === 200 && Array.isArray(res.body.results) && res.body.results.length === 0) {
      console.warn('[BS#825] Track 2 fallback returned no results; see earlier test for hint.');
      return;
    }
    expect(res.status).toBe(200);
    const matches = res.body.results.filter((row) => row.id === CTA_COLLISION.libraryId);
    expect(matches).toHaveLength(1);
    // The single hit must come from Track 1 (CTA) — Track 2 must not
    // duplicate it. matched_via.source = 'cta' is the load-bearing
    // observation: if Track 2 had emitted alongside, the hit's
    // matched_via would also (or only) carry 'discogs_master' from the
    // mock-LML response.
    expect(Array.isArray(matches[0].matched_via)).toBe(true);
    expect(matches[0].matched_via.length).toBeGreaterThanOrEqual(1);
    matches[0].matched_via.forEach((hint) => {
      expect(hint.source).toBe('cta');
    });
  });
});

/**
 * GET /library/ — catalog-route cascade (BS#972).
 *
 * `searchForAlbum` (mounted at `GET /library/`) is what dj-site's classic +
 * modern catalog live-search and the iOS DJ tool both call. Today it
 * shortcuts straight to `libraryService.fuzzySearchLibrary`, which tops out
 * at tsvector + trigram — the CTA + LML `/lookup` cascade in
 * `libraryService.searchLibrary` is unreachable from any catalog HTTP route.
 * That makes `matched_via` empty on every wire response, so dj-site's
 * MatchedTrackChips and iOS's MatchedTrackBadge stay dark even with both
 * flags strict-`true`.
 *
 * These cases drive the same CTA + Track 2 fixtures as the `/library/search`
 * suites above, but through the catalog route. They follow the
 * skip-if-flag-off pattern: a 0-result response in CI means the flag isn't
 * set; the test warns and short-circuits.
 *
 * dj-site sends the same string as both `artist_name` and `album_title`
 * (both-mode) for its live search; that's the case wired here. Split-field
 * queries stay on the legacy `fuzzySearchLibrary` path and don't run the
 * cascade — out of scope for this ticket.
 */
describe('GET /library cascade — catalog route serves matched_via (BS#972)', () => {
  let auth;
  // CTA fixture (mirror of the BS#819 block above).
  const CTA_LIBRARY_ID = 7000;
  const CTA_ALBUM_TITLE = 'Shape Fixture Album Alpha 1';
  const CTA_ARTIST = 'Shape Fixture Artist Alpha';
  // Track 2 fixture (mirror of the BS#825 block above).
  const CONFIELD_LIBRARY_ID = 7100;
  const CONFIELD_ALBUM_TITLE = 'Confield';
  const CONFIELD_TRACK_QUERY = 'vi scose poise';

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('both-mode CTA query returns the comp library row with matched_via.source = "cta"', async () => {
    const res = await auth
      .get('/library')
      .query({ artist_name: 'Bioluminescence', album_title: 'Bioluminescence', n: 10 })
      .expect(200);

    expectArray(res);
    if (res.body.length === 0) {
      console.warn(
        '[BS#972] /library/ catalog cascade returned no results. Likely the backend is running ' +
          'without CATALOG_TRACK_SEARCH_CTA_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }

    const hit = res.body.find((row) => row.id === CTA_LIBRARY_ID);
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
  });

  test('both-mode Track 2 query ("vi scose poise") returns Confield via LML fallback', async () => {
    const res = await auth
      .get('/library')
      .query({ artist_name: CONFIELD_TRACK_QUERY, album_title: CONFIELD_TRACK_QUERY, n: 10 })
      .expect(200);

    expectArray(res);
    if (res.body.length === 0) {
      console.warn(
        '[BS#972] /library/ catalog cascade returned no Track 2 results. Likely the backend is running ' +
          'without CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }

    const hit = res.body.find((row) => row.id === CONFIELD_LIBRARY_ID);
    expect(hit).toBeDefined();
    expect(hit.album_title).toBe(CONFIELD_ALBUM_TITLE);
    expect(Array.isArray(hit.matched_via)).toBe(true);
    expect(hit.matched_via.length).toBeGreaterThanOrEqual(1);
    // Mock LML's songLookup map returns matched_via.source = 'discogs_master'
    // for the Confield row; bridged via library.legacy_release_id back to BS.
    expect(hit.matched_via.some((m) => m.source && m.source.startsWith('discogs'))).toBe(true);
  });

  test('direct tsvector hit never carries matched_via (cascade only fires on primary 0-hit)', async () => {
    // 'Built to Spill' is in the seed fixture and matches tsvector cleanly;
    // the cascade must NOT fire, so the response must not carry matched_via.
    const res = await auth
      .get('/library')
      .query({ artist_name: 'Built to Spill', album_title: 'Built to Spill', n: 5 })
      .expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    res.body.forEach((row) => {
      expect(row.matched_via).toBeUndefined();
    });
  });

  test('split-field queries skip the cascade (not in scope for #972)', async () => {
    // artist_name !== album_title routes through the legacy fuzzySearchLibrary
    // path. With nonsense values for both fields, the response must be empty
    // (no cascade backfill, no matched_via).
    const res = await auth
      .get('/library')
      .query({ artist_name: 'xyznoartist', album_title: 'xyznoalbum', n: 5 })
      .expect(200);

    expectArray(res);
    expect(res.body.length).toBe(0);
  });
});

describe('Library artist_name cascade trigger (A.3 / 0060)', () => {
  const postgres = require('postgres');
  let sql;
  let artistId;
  let albumIds;
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const originalName = `Cascade Origin ${Date.now()}`;
  const renamedName = `Cascade Renamed ${Date.now()}`;

  beforeAll(async () => {
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
    });

    // Seed: one artist, two library rows for that artist with the
    // pre-rename denormalized name.
    const codeLetters = `Z${Date.now().toString(36).toUpperCase().slice(-2)}`;
    const artistRes = await sql.unsafe(`
      INSERT INTO ${schema}.artists (artist_name, alphabetical_name, code_letters)
      VALUES ('${originalName}', '${originalName}', '${codeLetters}')
      RETURNING id
    `);
    artistId = artistRes[0].id;

    const albumRes = await sql.unsafe(`
      INSERT INTO ${schema}.library
        (artist_id, genre_id, format_id, album_title, label, code_number, artist_name)
      VALUES
        (${artistId}, 11, 1, 'Cascade Album One', 'Cascade Label', 1, '${originalName}'),
        (${artistId}, 11, 1, 'Cascade Album Two', 'Cascade Label', 2, '${originalName}')
      RETURNING id
    `);
    albumIds = albumRes.map((r) => r.id);
  });

  afterAll(async () => {
    if (albumIds?.length) {
      await sql.unsafe(`DELETE FROM ${schema}.library WHERE id IN (${albumIds.join(',')})`);
    }
    if (artistId) {
      await sql.unsafe(`DELETE FROM ${schema}.artists WHERE id = ${artistId}`);
    }
    await sql.end();
  });

  test('renaming artists.artist_name updates every library row for that artist', async () => {
    await sql.unsafe(`
      UPDATE ${schema}.artists
         SET artist_name = '${renamedName}'
       WHERE id = ${artistId}
    `);

    const rows = await sql.unsafe(
      `SELECT artist_name FROM ${schema}.library WHERE artist_id = ${artistId} ORDER BY id`
    );

    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row.artist_name).toBe(renamedName));
  });
});

describe('Library Artists Search', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('searches artists in a genre by prefix', async () => {
    const res = await auth
      .get('/library/artists/search')
      .query({ genre_id: 11, q: 'Bu', limit: 10 })
      .expect(200);

    expect(res.body.artists).toBeDefined();
    expect(Array.isArray(res.body.artists)).toBe(true);
    expect(res.body.artists.length).toBeGreaterThan(0);
    const built = res.body.artists.find((a) =>
      a.artist_name.toLowerCase().includes('built')
    );
    expect(built).toBeDefined();
    expectFields(built, 'id', 'artist_name', 'code_letters', 'code_number');
    expect(built.code_letters).toBe('BU');
  });

  test('returns 400 when q is too short', async () => {
    const res = await auth
      .get('/library/artists/search')
      .query({ genre_id: 11, q: 'B' })
      .expect(400);

    expectErrorContains(res, 'q');
  });

  test('returns 400 when genre_id is invalid', async () => {
    const res = await auth
      .get('/library/artists/search')
      .query({ genre_id: 0, q: 'Bu' })
      .expect(400);

    expectErrorContains(res, 'genre_id');
  });
});

describe('Library Artists Peek Code', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('peeks next code_artist_number', async () => {
    const res = await auth.get('/library/artists/peek-code').query({ code_letters: 'BU', genre_id: 11 }).expect(200);

    // BU is the code for Built to Spill and has artist_genre_code 60
    expect(res.body.next_code_number).toBe(61);
  });
});

describe('Library Formats', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/formats', () => {
    test('returns formats as an array', async () => {
      const res = await auth.get('/library/formats').expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('formats have expected fields', async () => {
      const res = await auth.get('/library/formats').expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'id', 'format_name');
      }
    });
  });

  describe('POST /library/formats', () => {
    test('adds new format', async () => {
      const uniqueSuffix = Date.now();
      const res = await auth
        .post('/library/formats')
        .send({
          name: `Test Format ${uniqueSuffix}`,
        })
        .expect(201);

      expectFields(res.body, 'id', 'format_name');
      expect(res.body.format_name).toContain('Test Format');
    });

    test('returns 400 when name is missing', async () => {
      const res = await auth.post('/library/formats').send({}).expect(400);

      expectErrorContains(res, 'Missing Parameter');
    });
  });
});

describe('Library Genres', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/genres', () => {
    test('returns genres as an array', async () => {
      const res = await auth.get('/library/genres').expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('genres have expected fields', async () => {
      const res = await auth.get('/library/genres').expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'id', 'genre_name');
      }
    });
  });

  describe('POST /library/genres', () => {
    test('adds new genre', async () => {
      const uniqueSuffix = Date.now();
      const res = await auth
        .post('/library/genres')
        .send({
          name: `Test Genre ${uniqueSuffix}`,
          description: 'A test genre for integration testing',
        })
        .expect(201);

      expectFields(res.body, 'id', 'genre_name');
      expect(res.body.genre_name).toContain('Test Genre');
    });

    test('returns 400 when name is missing', async () => {
      const res = await auth
        .post('/library/genres')
        .send({
          description: 'Test description',
        })
        .expect(400);

      expectErrorContains(res, 'name and description are required');
    });

    test('returns 400 when description is missing', async () => {
      const res = await auth
        .post('/library/genres')
        .send({
          name: 'Test Genre',
        })
        .expect(400);

      expectErrorContains(res, 'name and description are required');
    });
  });
});

describe('Library Album Info', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/info', () => {
    test('returns album info for valid album_id', async () => {
      const res = await auth.get('/library/info').query({ album_id: 1 }).expect(200);

      expectFields(res.body, 'id', 'artist_name', 'alphabetical_name', 'album_title');
      expect(res.body.id).toBe(1);
    });

    test('returns album with all expected fields', async () => {
      const res = await auth.get('/library/info').query({ album_id: 1 }).expect(200);

      expectFields(
        res.body,
        'id',
        'artist_name',
        'alphabetical_name',
        'album_title',
        'code_letters',
        'code_number',
        'plays'
      );
    });

    test('returns 400 when album_id is missing', async () => {
      const res = await auth.get('/library/info').expect(400);

      expectErrorContains(res, 'missing album identifier');
    });

    test('returns undefined/empty for non-existent album_id', async () => {
      const res = await auth.get('/library/info').query({ album_id: 999999 }).expect(200);

      expect(res.body).toBeFalsy();
    });

    test('returns nested reconciled_identity (no flat external-ID columns)', async () => {
      const res = await auth.get('/library/info').query({ album_id: 1 }).expect(200);

      expect(res.body).toHaveProperty('reconciled_identity');
      expect(res.body).not.toHaveProperty('discogs_artist_id');
      expect(res.body).not.toHaveProperty('musicbrainz_artist_id');
      expect(res.body).not.toHaveProperty('wikidata_qid');
      expect(res.body).not.toHaveProperty('spotify_artist_id');
      expect(res.body).not.toHaveProperty('apple_music_artist_id');
      expect(res.body).not.toHaveProperty('bandcamp_id');
    });
  });
});
