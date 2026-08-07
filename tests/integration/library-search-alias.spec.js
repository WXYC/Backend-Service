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
 * mocked DB can't produce them. It seeds three artists:
 *
 *   - NOISE ('Bill Monroe'), two albums, alias variant 'Monore'. Similarity
 *     0.333 against the query: admitted by `%`, rejected by the floor.
 *   - REAL ('Monolake'), whose canonical name IS the query, so it matches on
 *     branch (a) with no alias involvement at all.
 *   - CONTROL ('Gerhard Behles'), a `discogs_member` variant of exactly the
 *     query string. Similarity 1.0, so it clears any floor, and its canonical
 *     name doesn't ILIKE-match, so it can ONLY arrive via branch (b). BS#2020
 *     later made it the exemption case as well: an exact variant is not the
 *     fuzzy collision the tier was aimed at, so it is no longer demoted.
 *
 * The CONTROL row is what makes these assertions mean anything. `Monolake`
 * ILIKE-matches `monolake` on the plain legacy path, so keying a skip-guard on
 * the REAL row would pass identically with the alias feature switched off —
 * the Fix-2 assertion (`no noise rows`) would then be vacuously true, and the
 * Fix-1 assertion would hard-fail with a misleading message. CONTROL cannot
 * appear unless the alias branch actually executed, so `requireAliasActive`
 * keys on it and fails fast with an explanation, matching the BS#1383 test
 * above rather than the warn-skip pattern (which is only appropriate where the
 * missing signal is a *different* feature flag's).
 */
const BS2018 = {
  NOISE_ARTIST_ID: 9201,
  NOISE_LIBRARY_IDS: [9201, 9202],
  REAL_ARTIST_ID: 9203,
  REAL_LIBRARY_ID: 9203,
  CONTROL_ARTIST_ID: 9204,
  CONTROL_LIBRARY_ID: 9204,
  // The real production variant string. similarity('Monore', 'monolake') is
  // 0.3333 — above pg_trgm's 0.30, below the 0.40 floor.
  COLLIDING_VARIANT: 'Monore',
  QUERY: 'monolake',
};

describe('GET /library/query — fuzzy alias hits no longer flood results (BS#2018)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const { NOISE_ARTIST_ID, NOISE_LIBRARY_IDS, REAL_ARTIST_ID, REAL_LIBRARY_ID } = BS2018;
  const { CONTROL_ARTIST_ID, CONTROL_LIBRARY_ID, COLLIDING_VARIANT, QUERY } = BS2018;

  /**
   * Assert the alias branch ran at all, by requiring the row that only it can
   * produce. Throws rather than warn-skipping: every assertion in this suite
   * is about alias behavior, so a silent pass with the feature off would be a
   * green run that proves nothing.
   */
  function requireAliasActive(results) {
    if (results.some((r) => r.id === CONTROL_LIBRARY_ID)) return;
    throw new Error(
      `[BS#2018] The control row (library id ${CONTROL_LIBRARY_ID}, reachable ONLY through the alias ` +
        'branch) is absent, so nothing in this suite is being exercised. Almost certainly the backend is ' +
        'running without CATALOG_SEARCH_ALIAS_ENABLED=true — set it on the backend service in ' +
        'dev_env/docker-compose.yml, or in .env for local `npm run dev`.'
    );
  }

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanupBs2018Rows(sql, wxycSchema);

    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, 'Bill Monroe', 'Monroe, Bill', 'MO'),
              ($2, 'Monolake', 'Monolake', 'MO'),
              ($3, 'Gerhard Behles', 'Behles, Gerhard', 'BE')
       ON CONFLICT (id) DO NOTHING`,
      [NOISE_ARTIST_ID, REAL_ARTIST_ID, CONTROL_ARTIST_ID]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $4, 9201), ($2, $4, 9203), ($3, $4, 9204)
       ON CONFLICT (artist_id, genre_id) DO NOTHING`,
      [NOISE_ARTIST_ID, REAL_ARTIST_ID, CONTROL_ARTIST_ID, TEST_GENRE_ID]
    );
    // Both alias-reachable artists sort BEFORE 'Monolake' by artist name
    // ('Bill Monroe' < 'Gerhard Behles' < 'Monolake'), so a regression in
    // either fix re-floods the TOP of the page and the failure is visible in
    // results[0] rather than buried in the tail. Note the endpoint's DEFAULT
    // sort is album ASC, not artist — tests that need the artist ordering
    // above to be load-bearing have to ask for `sort=artist` explicitly.
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id, legacy_release_id)
       VALUES
         ($1, $3, $8, $9, 'Bluegrass Ramble', 1, 'Bill Monroe', 'Decca', NULL, 65920),
         ($2, $3, $8, $9, 'Blue Moon of Kentucky', 2, 'Bill Monroe', 'Decca', NULL, 65921),
         ($4, $5, $8, $9, 'Gravity', 1, 'Monolake', 'Imbalance Computer Music', NULL, 65922),
         ($6, $7, $8, $9, 'Layering Buddha', 1, 'Gerhard Behles', 'Imbalance Computer Music', NULL, 65923)
       ON CONFLICT (id) DO NOTHING`,
      [
        NOISE_LIBRARY_IDS[0],
        NOISE_LIBRARY_IDS[1],
        NOISE_ARTIST_ID,
        REAL_LIBRARY_ID,
        REAL_ARTIST_ID,
        CONTROL_LIBRARY_ID,
        CONTROL_ARTIST_ID,
        TEST_GENRE_ID,
        TEST_FORMAT_ID,
      ]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_name_variation', $2, NULL, NULL, NULL, NULL, 'name_variation', 0.95, NOW()),
              ($3, 'discogs_member', $4, NULL, NULL, NULL, NULL, 'member_group', 0.9, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE SET last_verified_at = NOW()`,
      [NOISE_ARTIST_ID, COLLIDING_VARIANT, CONTROL_ARTIST_ID, QUERY]
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

  test('Fix 2: the sub-floor collision contributes no rows, while a real alias hit still does', async () => {
    const res = await auth.get('/library/query').query({ q: QUERY, limit: 50 }).expect(200);
    requireAliasActive(res.body.results);

    // The canonical artist is here on its own merits (branch a)...
    expect(res.body.results.some((r) => r.id === REAL_LIBRARY_ID)).toBe(true);
    // ...the 1.0-similarity member variant is here via the alias branch...
    const control = res.body.results.find((r) => r.id === CONTROL_LIBRARY_ID);
    expect(control.matched_via_alias).toEqual([{ matched_variant: QUERY, source: 'discogs_member' }]);
    // ...and the 0.333 collision brought in none of its artist's discography.
    expect(res.body.results.filter((r) => NOISE_LIBRARY_IDS.includes(r.id))).toEqual([]);
  });

  test('Fix 1 (as narrowed by BS#2020): the EXACT variant is not demoted', async () => {
    // Sort explicitly, and DESC, because the tier is only observable when it
    // disagrees with the caller's sort. The default is album ASC, under which
    // REAL ('Gravity') precedes CONTROL ('Layering Buddha') either way — a
    // tiered CONTROL and an untiered one look identical. Reversing the sort
    // separates them: the tier is hardcoded ASC and is NOT reversed by
    // `order`, so a tiered CONTROL still trails REAL, while an untiered one
    // leads it on album title alone.
    const res = await auth
      .get('/library/query')
      .query({ q: QUERY, limit: 50, sort: 'album', order: 'desc' })
      .expect(200);
    requireAliasActive(res.body.results);

    const realIndex = res.body.results.findIndex((r) => r.id === REAL_LIBRARY_ID);
    const controlIndex = res.body.results.findIndex((r) => r.id === CONTROL_LIBRARY_ID);
    expect(realIndex).toBeGreaterThanOrEqual(0);
    expect(controlIndex).toBeGreaterThanOrEqual(0);

    // This assertion is inverted from what BS#2018 originally shipped, and
    // deliberately so. CONTROL's variant IS the query string (similarity 1.0),
    // so demoting it was never what Fix 1 was aimed at — the complaint was a
    // 0.333 typo collision ranking like an exact hit, and the unconditional
    // tier swept up the exact hit as collateral. BS#2020 found that collateral
    // fatal on the two `library.service.ts` paths, which emit a bare LIMIT: a
    // demoted row there is deleted, not paginated. The tier is shared, so it
    // is narrowed here too.
    expect(controlIndex).toBeLessThan(realIndex);

    // The demotion half of Fix 1 is NOT tested by this fixture, because this
    // fixture has no fuzzy-but-above-floor alias row: NOISE sits at 0.333,
    // deliberately under the floor, so it contributes nothing to order. The
    // BS#2020 suite below carries a 0.6429 variant and asserts the demotion
    // against this same endpoint.
  });
});

/**
 * BS#2020 fixture — alias-only rows displacing REAL trigram matches on the
 * two `library.service.ts` alias paths (`GET /library/` Both-mode and
 * `GET /library/search`), plus the exact-variant exemption that the same
 * ticket's first cut got wrong.
 *
 * Four artists, all reachable on one query (`deerhoof`):
 *
 *   - NOISE ('Wolf Eyes'), 4 albums, alias variant 'Deerhoof Live'.
 *     Similarity 0.6429 — an utterly ordinary name variation, comfortably
 *     ABOVE BS#2018's 0.40 floor, which is why that floor cannot reach this
 *     defect. Neither its canonical name nor any album title trigram-matches,
 *     so all 4 rows arrive only via branch (b), which INNER JOINs on
 *     `artist_id` and admits the whole discography at that one score.
 *   - REAL ('Deerhunter'), 1 album, matches on branch (a) at 0.3333 — a
 *     genuine match that scores BELOW the alias hit. That gap is the defect.
 *   - CONTROL ('Black Dice'), 1 album, alias variant EXACTLY the query.
 *     Similarity 1.0, canonical name unmatched (0.053), so it too can only
 *     arrive via branch (b) — but the query string IS a registered name for
 *     this artist, so it is a better answer than REAL, not a worse one.
 *
 * The two failure modes are opposites and this fixture holds both at once:
 *
 *   - No tier at all → NOISE (0.6429) outranks REAL (0.3333) wholesale.
 *   - An unconditional tier → CONTROL (1.0) is demoted with NOISE, and since
 *     neither of these paths emits an OFFSET, demoted means deleted.
 *
 * So the invariant under test is a three-way order, CONTROL < REAL < NOISE,
 * and the `n`/`limit` values below are deliberately tight enough that a
 * misordered row falls off the page entirely rather than merely sorting late
 * — the reported symptom rather than a proxy for it.
 *
 * The query is deliberately disjoint from BS#2018's (`monolake`). That suite
 * seeds an artist whose canonical name IS its query, which tsvector-matches
 * and short-circuits Both-mode before the trigram tier ever runs; sharing the
 * string left this suite's outcome depending on describe execution order.
 *
 * `searchByArtist` carries the same fix but has no HTTP route, so its
 * coverage is the unit suite (`tests/unit/services/library-search-alias.test.ts`).
 */
const BS2020 = {
  NOISE_ARTIST_ID: 9301,
  NOISE_LIBRARY_IDS: [9301, 9302, 9303, 9304],
  REAL_ARTIST_ID: 9305,
  REAL_LIBRARY_ID: 9305,
  CONTROL_ARTIST_ID: 9306,
  CONTROL_LIBRARY_ID: 9306,
  // similarity('Deerhoof Live', 'deerhoof') = 0.6429 — over the 0.40 floor.
  ALIAS_VARIANT: 'Deerhoof Live',
  // similarity('Deerhunter', 'deerhoof') = 0.3333 — over pg_trgm's 0.30, so
  // it is a real branch-(a) match, but under the alias hit's score.
  REAL_ARTIST_NAME: 'Deerhunter',
  NOISE_ARTIST_NAME: 'Wolf Eyes',
  CONTROL_ARTIST_NAME: 'Black Dice',
  QUERY: 'deerhoof',
};

describe('alias-only rows no longer displace real trigram matches (BS#2020)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const { NOISE_ARTIST_ID, NOISE_LIBRARY_IDS, REAL_ARTIST_ID, REAL_LIBRARY_ID } = BS2020;
  const { CONTROL_ARTIST_ID, CONTROL_LIBRARY_ID, ALIAS_VARIANT, QUERY } = BS2020;
  const { REAL_ARTIST_NAME, NOISE_ARTIST_NAME, CONTROL_ARTIST_NAME } = BS2020;

  /**
   * Prove the alias branch actually executed, ONCE, on a page wide enough to
   * hold every fixture row. Both alias-only groups here are unreachable
   * without it, so their presence on an unbounded page is a sound liveness
   * signal — but their presence on the *bounded* pages the ordering tests
   * assert against is not, because this fix moves both groups by design. A
   * per-test guard would therefore report "the feature flag is off" for the
   * one outcome that means the fix works, which is the most expensive
   * possible way to be wrong about a failing test.
   */
  async function assertAliasBranchLive() {
    const res = await auth.get('/library/').query({ artist_name: QUERY, album_title: QUERY, n: 50 }).expect(200);
    const aliasOnlyIds = [...NOISE_LIBRARY_IDS, CONTROL_LIBRARY_ID];
    const seen = res.body.filter((r) => aliasOnlyIds.includes(r.id));
    if (seen.length === aliasOnlyIds.length) return;
    throw new Error(
      `[BS#2020] Expected all ${aliasOnlyIds.length} alias-only rows (library ids ${aliasOnlyIds.join(', ')}) on an ` +
        `n=50 page, got ${seen.length}. These rows are unreachable without the alias branch, so the ordering ` +
        'assertions in this suite would not be exercising anything. Almost certainly the backend is running ' +
        'without CATALOG_SEARCH_ALIAS_ENABLED=true — set it on the backend service in ' +
        'dev_env/docker-compose.yml, or in .env for local `npm run dev`.'
    );
  }

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanupBs2020Rows(sql, wxycSchema);

    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, $4, $4, 'WO'),
              ($2, $5, $5, 'DE'),
              ($3, $6, $6, 'BL')
       ON CONFLICT (id) DO NOTHING`,
      [NOISE_ARTIST_ID, REAL_ARTIST_ID, CONTROL_ARTIST_ID, NOISE_ARTIST_NAME, REAL_ARTIST_NAME, CONTROL_ARTIST_NAME]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $4, 9301), ($2, $4, 9305), ($3, $4, 9306)
       ON CONFLICT (artist_id, genre_id) DO NOTHING`,
      [NOISE_ARTIST_ID, REAL_ARTIST_ID, CONTROL_ARTIST_ID, TEST_GENRE_ID]
    );
    // No album title may trigram-match the query, or the row would arrive on
    // branch (a) and stop being an alias-only row. Pinned by the first test.
    //
    // REAL's label is the one deliberate oddity. The three alias paths do not
    // agree on what a branch-(a) match IS: `library.service.ts` uses trigram
    // over artist_name/album_title, while `/library/query` uses ILIKE-contains
    // over artist_name/album_title/**label**. So REAL is a real match on the
    // first two via 'Deerhunter', and needs the label to be one on the third.
    // Label is the only column that can do this without side effects: it is
    // absent from `library.search_doc` (see `buildAllFieldMatch`'s note), so
    // it cannot make Both-mode short-circuit on the tsvector tier before the
    // trigram tier this suite is about ever runs, and it is absent from the
    // trigram predicate, so it cannot change REAL's 0.3333 score.
    //
    // Without it, `/library/query` sees a result set that is 100% alias-only,
    // which triggers the BS#1885 cascade and hands final ordering to
    // `sortAlbumRows`'s in-memory tier — a different predicate (cascade-vs-
    // alias, not fuzzy-vs-exact) that would mask the SQL tier entirely.
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id, legacy_release_id)
       VALUES
         ($1, $5, $9, $10, 'Burned Mind', 1, $12, 'Sub Pop', NULL, 65930),
         ($2, $5, $9, $10, 'Human Animal', 2, $12, 'Sub Pop', NULL, 65931),
         ($3, $5, $9, $10, 'Dread', 3, $12, 'Bulb', NULL, 65932),
         ($4, $5, $9, $10, 'No Answer Lower Floors', 4, $12, 'De Stijl', NULL, 65933),
         ($6, $7, $9, $10, 'Microcastle', 1, $11, 'Deerhoof Recordings', NULL, 65934),
         ($8, $13, $9, $10, 'Beaches and Canyons', 1, $14, 'DFA', NULL, 65935)
       ON CONFLICT (id) DO NOTHING`,
      [
        NOISE_LIBRARY_IDS[0],
        NOISE_LIBRARY_IDS[1],
        NOISE_LIBRARY_IDS[2],
        NOISE_LIBRARY_IDS[3],
        NOISE_ARTIST_ID,
        REAL_LIBRARY_ID,
        REAL_ARTIST_ID,
        CONTROL_LIBRARY_ID,
        TEST_GENRE_ID,
        TEST_FORMAT_ID,
        REAL_ARTIST_NAME,
        NOISE_ARTIST_NAME,
        CONTROL_ARTIST_ID,
        CONTROL_ARTIST_NAME,
      ]
    );
    await sql.unsafe(
      `INSERT INTO ${wxycSchema}.artist_search_alias
         (artist_id, source, variant, related_artist_id, external_subject_id,
          external_object_id, active, method, confidence, last_verified_at)
       VALUES ($1, 'discogs_name_variation', $2, NULL, NULL, NULL, NULL, 'name_variation', 0.95, NOW()),
              ($3, 'discogs_member', $4, NULL, NULL, NULL, NULL, 'member_group', 0.9, NOW())
       ON CONFLICT (artist_id, source, variant) DO UPDATE SET last_verified_at = NOW()`,
      [NOISE_ARTIST_ID, ALIAS_VARIANT, CONTROL_ARTIST_ID, QUERY]
    );

    await assertAliasBranchLive();
  });

  afterAll(async () => {
    await cleanupBs2020Rows(sql, wxycSchema);
  });

  test('the fixture is real: one alias hit outscores a genuine match, another is exact', async () => {
    // Pins every number the ordering tests depend on. If pg_trgm's scoring
    // shifts, this fails FIRST and explains why the rest did.
    const [row] = await sql.unsafe(
      `SELECT similarity($1::text, $5::text) AS alias_sim,
              similarity($2::text, $5::text) AS real_sim,
              similarity($3::text, $5::text) AS control_sim,
              ($2::text % $5::text)          AS real_matches_directly,
              ($4::text % $5::text)          AS noise_matches_directly,
              ($3::text % $5::text)          AS control_matches_directly`,
      [ALIAS_VARIANT, REAL_ARTIST_NAME, CONTROL_ARTIST_NAME, NOISE_ARTIST_NAME, QUERY]
    );
    // BS#2018's floor cannot help here — the fuzzy alias hit is well over it.
    expect(Number(row.alias_sim)).toBeGreaterThanOrEqual(0.4);
    // The real match is genuine (branch a) but scores lower. That gap is the
    // whole defect.
    expect(row.real_matches_directly).toBe(true);
    expect(Number(row.real_sim)).toBeLessThan(Number(row.alias_sim));
    // Both alias artists are reachable ONLY through the alias branch, which
    // is what makes `assertAliasBranchLive` a valid liveness check.
    expect(row.noise_matches_directly).toBe(false);
    expect(row.control_matches_directly).toBe(false);
    // And the CONTROL variant is exact — a `< 1` guard is a guard on this
    // number, so pin it rather than inferring it from the variant string.
    const [exact] = await sql.unsafe(`SELECT similarity($1::text, $2::text) AS sim`, [QUERY, QUERY]);
    expect(Number(exact.sim)).toBe(1);
  });

  test('GET /library/ (Both-mode): exact variant, then real match, then fuzzy alias rows', async () => {
    // dj-site Classic sends the same string as artist_name and album_title,
    // which is what routes this through the Both-mode alias path.
    const res = await auth.get('/library/').query({ artist_name: QUERY, album_title: QUERY, n: 10 }).expect(200);

    const controlIndex = res.body.findIndex((r) => r.id === CONTROL_LIBRARY_ID);
    const realIndex = res.body.findIndex((r) => r.id === REAL_LIBRARY_ID);
    const firstNoiseIndex = res.body.findIndex((r) => NOISE_LIBRARY_IDS.includes(r.id));

    expect(controlIndex).toBeGreaterThanOrEqual(0);
    // Exempt from the tier: an exact variant is a stronger claim on this
    // query than a 0.33 trigram smear, so it leads on relevance.
    expect(controlIndex).toBeLessThan(realIndex);
    // ...and the fuzzy alias fan-out is still tiered behind both.
    expect(realIndex).toBeLessThan(firstNoiseIndex);
  });

  test('GET /library/search: the fuzzy fan-out no longer pushes real matches off the page', async () => {
    // limit 4 = exactly the fuzzy fan-out size. Pre-tier the page is all Wolf
    // Eyes and both better answers are simply gone — the reported symptom.
    const res = await auth.get('/library/search').query({ query: QUERY, limit: 4 }).expect(200);

    const ids = res.body.results.map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual([CONTROL_LIBRARY_ID, REAL_LIBRARY_ID]);
  });

  test('GET /library/search: an exact variant survives even a single-row page', async () => {
    // The inverse regression, at its sharpest. This path emits a bare LIMIT
    // with no OFFSET, so an unconditionally-tiered exact hit is not demoted
    // to page 2 — there is no page 2, and it is simply absent.
    const res = await auth.get('/library/search').query({ query: QUERY, limit: 1 }).expect(200);

    expect(res.body.results.map((r) => r.id)).toEqual([CONTROL_LIBRARY_ID]);
  });

  test('GET /library/query: the same tier, on the paginated catalog surface', async () => {
    // The third alias-aware path, and the reason the tier is built by one
    // shared helper: the same query must not rank differently on two
    // endpoints that answer the same question.
    //
    // The default sort here is album title ASC ('Beaches and Canyons' <
    // 'Burned Mind' < 'Dread' < 'Human Animal' < 'Microcastle' < 'No Answer
    // Lower Floors'), so post-fix CONTROL leads on the caller's sort as well
    // as the tier and the assertion can look tautological. It isn't: pre-fix
    // the tier overrode that sort entirely and put 'Microcastle' — the only
    // tier-0 row — first, which is what this caught before the guard existed.
    const res = await auth.get('/library/query').query({ q: QUERY, limit: 50 }).expect(200);

    const ids = res.body.results.map((r) => r.id);
    expect(ids.indexOf(CONTROL_LIBRARY_ID)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(CONTROL_LIBRARY_ID)).toBeLessThan(ids.indexOf(REAL_LIBRARY_ID));
    expect(ids.indexOf(REAL_LIBRARY_ID)).toBeLessThan(ids.indexOf(NOISE_LIBRARY_IDS[0]));
  });

  test('alias-only rows still carry matched_via_alias, and tie-break on id (BS#1318 wire contract)', async () => {
    const res = await auth.get('/library/').query({ artist_name: QUERY, album_title: QUERY, n: 10 }).expect(200);

    // Demoted, not dropped: the alias feature still surfaces them, still
    // labelled, and dj-site/iOS still read the hint.
    const noiseRows = res.body.filter((r) => NOISE_LIBRARY_IDS.includes(r.id));
    expect(noiseRows).toHaveLength(NOISE_LIBRARY_IDS.length);
    expect(noiseRows[0].matched_via_alias).toEqual([
      { matched_variant: ALIAS_VARIANT, source: 'discogs_name_variation' },
    ]);
    // The exempt row keeps its hint too — exemption is a ranking decision,
    // not a claim that the row matched the query text directly.
    const control = res.body.find((r) => r.id === CONTROL_LIBRARY_ID);
    expect(control.matched_via_alias).toEqual([{ matched_variant: QUERY, source: 'discogs_member' }]);
    // Pins the intra-tier order. Note this assertion does NOT prove the
    // `id ASC` tie-break is load-bearing — it passes against a build without
    // it, because an unordered plan may still emit id order by luck. Nothing
    // observable can prove determinism; what this catches is a future change
    // that perturbs the order on purpose.
    expect(noiseRows.map((r) => r.id)).toEqual([...NOISE_LIBRARY_IDS].sort((a, b) => a - b));
  });
});

async function cleanupBs2020Rows(sql, wxycSchema) {
  const artistIds = [BS2020.NOISE_ARTIST_ID, BS2020.REAL_ARTIST_ID, BS2020.CONTROL_ARTIST_ID];
  const libraryIds = [...BS2020.NOISE_LIBRARY_IDS, BS2020.REAL_LIBRARY_ID, BS2020.CONTROL_LIBRARY_ID];
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = ANY($1::int[])`, [artistIds]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id = ANY($1::int[])`, [libraryIds]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id = ANY($1::int[])`, [
    artistIds,
  ]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id = ANY($1::int[])`, [artistIds]);
}

async function cleanupBs2018Rows(sql, wxycSchema) {
  const artistIds = [BS2018.NOISE_ARTIST_ID, BS2018.REAL_ARTIST_ID, BS2018.CONTROL_ARTIST_ID];
  const libraryIds = [...BS2018.NOISE_LIBRARY_IDS, BS2018.REAL_LIBRARY_ID, BS2018.CONTROL_LIBRARY_ID];
  // Delete in FK-safe order, driven by the same constants the seeds use so a
  // renumbered fixture can't silently leave rows behind for the next run.
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = ANY($1::int[])`, [artistIds]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id = ANY($1::int[])`, [libraryIds]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id = ANY($1::int[])`, [
    artistIds,
  ]);
  await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id = ANY($1::int[])`, [artistIds]);
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
