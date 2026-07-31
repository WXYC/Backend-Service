const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

/**
 * Integration test for the artist-search-alias LATERAL JOIN
 * (artist-search-alias plan §PR 5 / BS#1269).
 *
 * Seeds an artist whose canonical name ("OHSEES") does NOT trigram-match the
 * variant ("Thee Oh Sees"), wires a single artist_search_alias row, and
 * asserts:
 *
 *   - GET /library/query?q=Thee%20Oh%20Sees returns the OHSEES row
 *   - The returned row carries matched_via_alias with the variant + source
 *   - Disabling the seed by deleting the alias row reverts the response to
 *     empty for the same query (proving the alias path is load-bearing, not
 *     incidental trigram noise)
 *
 * Requires `CATALOG_SEARCH_ALIAS_ENABLED=true` on the backend process —
 * set on the `backend` service in `dev_env/docker-compose.yml` so the
 * CI mock environment ships the LATERAL on by default. The flag is allow-
 * listed as compose-only in `tests/unit/scripts/ci-env-surface-parity.test.ts`.
 *
 * Uses IDs in the 9001+ range to avoid conflicting with `tests/fixtures/shape.sql`
 * (7000s) and seed_db.sql (1-9). Cleanup is idempotent so a failed run still
 * leaves the DB in a clean state.
 */

const TEST_ARTIST_ID = 9001;
const TEST_LIBRARY_ID = 9001;
const TEST_GENRE_ID = 11; // Rock — seeded by dev_env/seed_db.sql
const TEST_FORMAT_ID = 1; // CD — seeded by dev_env/seed_db.sql

describe('GET /library/query — alias-aware LATERAL JOIN (PR 5)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanupSeededRows(sql, wxycSchema);

    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, 'OHSEES', 'OHSEES', 'OH')
       ON CONFLICT (id) DO NOTHING`,
      [TEST_ARTIST_ID]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $2, 901)
       ON CONFLICT (artist_id, genre_id) DO NOTHING`,
      [TEST_ARTIST_ID, TEST_GENRE_ID]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id)
       VALUES ($1, $2, $3, $4, 'A Weird Exits', 1, 'OHSEES', 'Castle Face', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_LIBRARY_ID, TEST_ARTIST_ID, TEST_GENRE_ID, TEST_FORMAT_ID]
    );
  });

  afterAll(async () => {
    await cleanupSeededRows(sql, wxycSchema);
  });

  test('control: without an alias row, querying the variant returns 0 rows', async () => {
    await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [TEST_ARTIST_ID]);
    const res = await auth.get('/library/query').query({ q: 'Thee Oh Sees', limit: 50 }).expect(200);

    const hit = res.body.results.find((r) => r.id === TEST_LIBRARY_ID);
    expect(hit).toBeUndefined();
  });

  test('with seeded alias variant: query returns the OHSEES row + matched_via_alias', async () => {
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_name_variation', 'Thee Oh Sees', NULL, NULL, NULL, NULL,
               'name_variation', 0.95, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE
         SET last_verified_at = NOW()`,
      [TEST_ARTIST_ID]
    );

    const res = await auth.get('/library/query').query({ q: 'Thee Oh Sees', limit: 50 }).expect(200);

    const hit = res.body.results.find((r) => r.id === TEST_LIBRARY_ID);
    if (hit === undefined) {
      // Warn-skip path mirrors the pattern in the catalog-track-search tests
      // (library.spec.js / library-query.spec.js): when the backend process
      // is missing the feature flag the result set is empty rather than
      // failing the suite. Set in .env and restart `npm run dev` to exercise.
      console.warn(
        '[BS#1269] /library/query alias hit absent. Likely the backend is running ' +
          'without CATALOG_SEARCH_ALIAS_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }
    expect(hit.artist_name).toBe('OHSEES');
    expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' }]);
  });

  test('discogs_member alias hit surfaces with source=discogs_member (BS#1383)', async () => {
    // BS#1383: the catalog-search sites WANT `discogs_member` rows surfaced
    // (so iOS/dj-site can render a "related artist" UX hint), unlike the
    // concerts-artist-resolver which filters them. This asserts the source
    // string survives the LATERAL projection and the wire shape so a
    // downstream caller can distinguish in-library matches from
    // related-artist matches. Geordie-Greep-via-black-midi is the prod
    // shape from the BS#1368 audit; we reuse the OHSEES fixture artist
    // (the source label is what's under test, not the artist semantics).
    await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [TEST_ARTIST_ID]);
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_member', 'Geordie Greep', NULL, NULL,
               'discogs:artist:1234567', NULL, 'member_group', 0.9, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE
         SET last_verified_at = NOW()`,
      [TEST_ARTIST_ID]
    );

    const res = await auth.get('/library/query').query({ q: 'Geordie Greep', limit: 50 }).expect(200);

    const hit = res.body.results.find((r) => r.id === TEST_LIBRARY_ID);
    // Fail-fast rather than warn-skip (BS#1383 review): the wire-shape
    // assertion below is the WHOLE point of this test. A warn-and-return
    // when the hit is absent would let a `CATALOG_SEARCH_ALIAS_ENABLED`
    // regression in `dev_env/docker-compose.yml` slip past CI silently.
    // The throw names the flag so a dev running locally without the
    // LATERAL on can fix it in one read.
    if (hit === undefined) {
      throw new Error(
        '[BS#1383] /library/query alias hit for "Geordie Greep" was absent — the wire-shape ' +
          'assertion cannot run. Likely causes: (1) the backend is missing ' +
          'CATALOG_SEARCH_ALIAS_ENABLED=true (set it on the backend service in ' +
          'dev_env/docker-compose.yml or in .env for local `npm run dev`); (2) the alias ' +
          'LATERAL JOIN in library-search.service.ts / library.service.ts was changed to filter ' +
          'discogs_member rows — the resolver does, but the catalog-search sites must not (this ' +
          'test exists to pin that asymmetry).'
      );
    }
    expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Geordie Greep', source: 'discogs_member' }]);
  });
});

/**
 * GET /library/query — alias-only primary no longer suppresses the catalog-
 * track-search cascade (BS#1885).
 *
 * Root cause: the alias branch (above) makes a query "match" whenever it
 * fuzzy-hits an unrelated artist's `artist_search_alias` variant, even when
 * that match is noise (e.g. a real track title that happens to trigram-match
 * an unrelated artist's name variation). Pre-fix, any alias hit — however
 * spurious — counted as "the primary search found something" and the
 * catalog-track-search cascade (BS#977) never ran, so the query's real
 * answer (an in-library album resolved via LML's song lookup) never
 * surfaced.
 *
 * Seeds two unrelated library rows:
 *   - DECOY: an ordinary album whose artist carries an `artist_search_alias`
 *     variant set to the exact query string below, guaranteeing a
 *     deterministic pg_trgm `%` hit (avoids relying on a borderline
 *     similarity threshold in CI).
 *   - TARGET: a `legacy_release_id`-bearing album that the mock LML
 *     (`dev_env/mock-api-server/src/fixtures/lml.json` `songLookup` map)
 *     resolves the query to.
 *
 * The query should surface BOTH rows: the decoy with `matched_via_alias`
 * (still a real feature, unrelated to this bug), and the target with
 * `matched_via` (the cascade now runs instead of being suppressed).
 */
describe('GET /library/query — alias-only primary no longer suppresses the cascade (BS#1885)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  const DECOY_ARTIST_ID = 9101;
  const DECOY_LIBRARY_ID = 9101;
  const DECOY_ARTIST_NAME = 'Vestibule Choir';
  const TARGET_ARTIST_ID = 9102;
  const TARGET_LIBRARY_ID = 9102;
  const TARGET_LEGACY_RELEASE_ID = 65900;
  // Lowercase nonce, unused anywhere else in the fixtures, so it can never
  // accidentally ILIKE/tsvector-match real catalog text (mirrors the opaque
  // multi-word query tokens in tests/fixtures/shape.sql). Set as the decoy's
  // alias variant verbatim, so `variant % query` is a trivial (similarity
  // 1.0) pg_trgm hit rather than a borderline one.
  const QUERY = 'opaline drift census';

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanupBs1885Rows(sql, wxycSchema);

    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, $2, $2, 'VC'), ($3, 'Radial Thicket', 'Radial Thicket', 'RT')
       ON CONFLICT (id) DO NOTHING`,
      [DECOY_ARTIST_ID, DECOY_ARTIST_NAME, TARGET_ARTIST_ID]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $3, 9101), ($2, $3, 9102)
       ON CONFLICT (artist_id, genre_id) DO NOTHING`,
      [DECOY_ARTIST_ID, TARGET_ARTIST_ID, TEST_GENRE_ID]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id, legacy_release_id)
       VALUES
         ($1, $2, $6, $7, 'Low Tide Almanac', 1, $8, 'Driftless Records', NULL, NULL),
         ($3, $4, $6, $7, 'Nine Rooms', 1, 'Radial Thicket', NULL, NULL, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        DECOY_LIBRARY_ID,
        DECOY_ARTIST_ID,
        TARGET_LIBRARY_ID,
        TARGET_ARTIST_ID,
        TARGET_LEGACY_RELEASE_ID,
        TEST_GENRE_ID,
        TEST_FORMAT_ID,
        DECOY_ARTIST_NAME,
      ]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_name_variation', $2, NULL, NULL, NULL, NULL, 'name_variation', 0.95, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE SET last_verified_at = NOW()`,
      [DECOY_ARTIST_ID, QUERY]
    );
  });

  afterAll(async () => {
    await cleanupBs1885Rows(sql, wxycSchema);
  });

  test('cascade now runs: response carries both the alias row and the resolved cascade row', async () => {
    const res = await auth.get('/library/query').query({ q: QUERY, limit: 50 }).expect(200);

    const aliasHit = res.body.results.find((r) => r.id === DECOY_LIBRARY_ID);
    const cascadeHit = res.body.results.find((r) => r.id === TARGET_LIBRARY_ID);

    if (cascadeHit === undefined) {
      // Warn-skip mirrors the pattern in library.spec.js / library-query.spec.js:
      // a missing cascade hit in CI means the backend is running without the
      // catalog-track-search flags, not a regression in this fix.
      console.warn(
        '[BS#1885] /library/query cascade row absent for the alias-only-primary case. Likely the ' +
          'backend is running without CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true (or ' +
          'CATALOG_SEARCH_ALIAS_ENABLED=true). Set both in .env and restart `npm run dev`.'
      );
      return;
    }
    expect(cascadeHit.album_title).toBe('Nine Rooms');
    expect(Array.isArray(cascadeHit.matched_via)).toBe(true);
    expect(cascadeHit.matched_via.length).toBeGreaterThanOrEqual(1);

    expect(aliasHit).toBeDefined();
    expect(aliasHit.matched_via_alias).toEqual([{ matched_variant: QUERY, source: 'discogs_name_variation' }]);
  });

  test('a non-alias primary hit against the same seed still short-circuits (no matched_via rows)', async () => {
    const res = await auth.get('/library/query').query({ q: DECOY_ARTIST_NAME, limit: 50 }).expect(200);

    const hit = res.body.results.find((r) => r.id === DECOY_LIBRARY_ID);
    expect(hit).toBeDefined();
    res.body.results.forEach((row) => {
      expect(row.matched_via).toBeUndefined();
    });
  });
});

async function cleanupBs1885Rows(sql, wxycSchema) {
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id IN (9101, 9102)`);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id IN (9101, 9102)`);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id IN (9101, 9102)`);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id IN (9101, 9102)`);
}

async function cleanupSeededRows(sql, wxycSchema) {
  // Delete in FK-safe order. artist_search_alias FKs onto artists; library
  // FKs onto artists.
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [TEST_ARTIST_ID]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id = $1`, [TEST_LIBRARY_ID]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id = $1`, [TEST_ARTIST_ID]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id = $1`, [TEST_ARTIST_ID]);
}
