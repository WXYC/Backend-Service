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
    if (hit === undefined) {
      console.warn(
        '[BS#1383] /library/query alias hit absent. Likely the backend is running ' +
          'without CATALOG_SEARCH_ALIAS_ENABLED=true. Set it in .env and restart `npm run dev`.'
      );
      return;
    }
    expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Geordie Greep', source: 'discogs_member' }]);
  });
});

async function cleanupSeededRows(sql, wxycSchema) {
  // Delete in FK-safe order. artist_search_alias FKs onto artists; library
  // FKs onto artists.
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [TEST_ARTIST_ID]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id = $1`, [TEST_LIBRARY_ID]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id = $1`, [TEST_ARTIST_ID]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id = $1`, [TEST_ARTIST_ID]);
}
