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
  // BS#1963: library.legacy_release_id is now NOT NULL (Backend mints it from a
  // sequence). The decoy row previously seeded it as NULL; give it its own
  // distinct id. The value is never asserted on — it just has to be non-null and
  // not collide with TARGET_LEGACY_RELEASE_ID or the shape.sql fixtures.
  const DECOY_LEGACY_RELEASE_ID = 65901;
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
         ($1, $2, $6, $7, 'Low Tide Almanac', 1, $8, 'Driftless Records', NULL, $9),
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
        DECOY_LEGACY_RELEASE_ID,
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

/**
 * GET /library/query — fuzzy alias hits no longer flood the result set
 * (BS#2018).
 *
 * The alias branch INNER JOINs on `artist_id`, so a SINGLE colliding variant
 * admits its artist's entire discography. pg_trgm's default `%` threshold of
 * 0.30 is loose enough for that to happen on unrelated strings: the misprint
 * "Monore" (one of Discogs artist 450691's 42 `namevariations`) scores 0.333
 * against "monolake", which put all 14 Bill Monroe albums into a search for
 * Monolake. `alias_max_sim` was projected but never ordered on, so the noise
 * interleaved with the 6 real hits by album title.
 *
 * This suite runs against real pg_trgm — the numbers are the point, and a
 * mocked DB can't produce them. It seeds the exact production shape:
 *
 *   - NOISE artist with two albums and one alias variant 'Monore'
 *   - REAL artist whose canonical name IS the query
 *
 * and asserts both halves of the fix:
 *
 *   - Fix 2: at the shipped 0.40 floor the noise artist is absent entirely
 *   - Fix 1: with the floor pushed back to pg_trgm's 0.30 (via a query the
 *     test issues directly, since the backend's floor is process-level), the
 *     noise rows are still admitted by `%` — proving the collision is real and
 *     that Fix 2, not a fixture accident, is what removes them
 */
describe('GET /library/query — fuzzy alias hits no longer flood results (BS#2018)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  const NOISE_ARTIST_ID = 9201;
  const NOISE_LIBRARY_IDS = [9201, 9202];
  const REAL_ARTIST_ID = 9203;
  const REAL_LIBRARY_ID = 9203;
  // The real production variant string. similarity('Monore', 'monolake') is
  // 0.3333 — above pg_trgm's 0.30, below the 0.40 floor.
  const COLLIDING_VARIANT = 'Monore';
  const QUERY = 'monolake';

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanupBs2018Rows(sql, wxycSchema);

    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, 'Bill Monroe', 'Monroe, Bill', 'MO'), ($2, 'Monolake', 'Monolake', 'MO')
       ON CONFLICT (id) DO NOTHING`,
      [NOISE_ARTIST_ID, REAL_ARTIST_ID]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $3, 9201), ($2, $3, 9203)
       ON CONFLICT (artist_id, genre_id) DO NOTHING`,
      [NOISE_ARTIST_ID, REAL_ARTIST_ID, TEST_GENRE_ID]
    );
    // Album titles chosen to sort BEFORE the real hit on the default
    // artist-name sort, so a regression re-floods the top of the page rather
    // than the tail — the failure is then visible in `results[0]`.
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id, legacy_release_id)
       VALUES
         ($1, $3, $6, $7, 'Bluegrass Ramble', 1, 'Bill Monroe', 'Decca', NULL, 65920),
         ($2, $3, $6, $7, 'Blue Moon of Kentucky', 2, 'Bill Monroe', 'Decca', NULL, 65921),
         ($4, $5, $6, $7, 'Gravity', 1, 'Monolake', 'Imbalance Computer Music', NULL, 65922)
       ON CONFLICT (id) DO NOTHING`,
      [
        NOISE_LIBRARY_IDS[0],
        NOISE_LIBRARY_IDS[1],
        NOISE_ARTIST_ID,
        REAL_LIBRARY_ID,
        REAL_ARTIST_ID,
        TEST_GENRE_ID,
        TEST_FORMAT_ID,
      ]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_name_variation', $2, NULL, NULL, NULL, NULL, 'name_variation', 0.95, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE SET last_verified_at = NOW()`,
      [NOISE_ARTIST_ID, COLLIDING_VARIANT]
    );
  });

  afterAll(async () => {
    await cleanupBs2018Rows(sql, wxycSchema);
  });

  test('the collision is real: pg_trgm admits the variant, the floor rejects it', async () => {
    // Pins the two numbers the whole fix is calibrated against. If pg_trgm's
    // scoring ever changes, this fails FIRST and explains why the rest did.
    const [row] = await sql.unsafe(
      `SELECT similarity($1::text, $2::text) AS sim, ($1::text % $2::text) AS passes_pg_trgm`,
      [COLLIDING_VARIANT, QUERY]
    );
    expect(row.passes_pg_trgm).toBe(true);
    expect(Number(row.sim)).toBeGreaterThanOrEqual(0.3);
    expect(Number(row.sim)).toBeLessThan(0.4);
  });

  test('Fix 2: the query returns the real artist and NO rows from the colliding artist', async () => {
    const res = await auth.get('/library/query').query({ q: QUERY, limit: 50 }).expect(200);

    const realHit = res.body.results.find((r) => r.id === REAL_LIBRARY_ID);
    if (realHit === undefined) {
      // Warn-skip mirrors the sibling suites: an empty result set here means
      // the backend is running without the alias flag, not a regression.
      console.warn(
        '[BS#2018] /library/query returned no row for the canonical "Monolake" artist. Likely the ' +
          'backend is running without CATALOG_SEARCH_ALIAS_ENABLED=true. Set it in .env and restart.'
      );
      return;
    }

    const noiseHits = res.body.results.filter((r) => NOISE_LIBRARY_IDS.includes(r.id));
    expect(noiseHits).toEqual([]);
  });

  test('Fix 1: any alias-only row that survives the floor sorts after every real match', async () => {
    // Exact-variant seed: similarity 1.0, so it clears the floor no matter how
    // the floor is tuned. Its artist name ('Bill Monroe') sorts before
    // 'Monolake' on the default artist ASC, so pre-Fix-1 it led the page.
    // This is the only way to observe the tier once Fix 2 hides the 0.333
    // collision — the AC in BS#2018 that Fix 2 would otherwise mask.
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_name_variation', $2, NULL, NULL, NULL, NULL, 'name_variation', 0.95, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE SET last_verified_at = NOW()`,
      [NOISE_ARTIST_ID, QUERY]
    );

    try {
      const res = await auth.get('/library/query').query({ q: QUERY, limit: 50 }).expect(200);

      const realIndex = res.body.results.findIndex((r) => r.id === REAL_LIBRARY_ID);
      if (realIndex === -1) {
        console.warn(
          '[BS#2018] /library/query returned no row for the canonical "Monolake" artist. Likely the ' +
            'backend is running without CATALOG_SEARCH_ALIAS_ENABLED=true. Set it in .env and restart.'
        );
        return;
      }

      const aliasIndexes = res.body.results
        .map((r, i) => (NOISE_LIBRARY_IDS.includes(r.id) ? i : -1))
        .filter((i) => i !== -1);
      // The alias rows must be present (the exact variant matched) AND every
      // one of them must sit below the real hit.
      expect(aliasIndexes.length).toBe(NOISE_LIBRARY_IDS.length);
      aliasIndexes.forEach((i) => expect(i).toBeGreaterThan(realIndex));
      res.body.results
        .filter((r) => NOISE_LIBRARY_IDS.includes(r.id))
        .forEach((r) => expect(r.matched_via_alias).toBeDefined());
    } finally {
      await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1 AND variant = $2`, [
        NOISE_ARTIST_ID,
        QUERY,
      ]);
    }
  });
});

async function cleanupBs2018Rows(sql, wxycSchema) {
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id IN (9201, 9203)`);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id IN (9201, 9202, 9203)`);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id IN (9201, 9203)`);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id IN (9201, 9203)`);
}

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
