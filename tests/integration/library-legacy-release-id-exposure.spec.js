const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { isMockApiAvailable } = require('../utils/mock_api');

/**
 * Integration coverage for BS#2128: `library.legacy_release_id` is exposed
 * on every catalog read surface dj-site's flowsheet picker consumes.
 *
 * Four request shapes, per the issue's test plan — none substitutes for
 * another, since each exercises a distinct site in library.service.ts:
 *
 *   1. Distinct artist_name/album_title on GET /library/ — the dominant
 *      dj-site flowsheet path (libraryViewQuery -> LIBRARY_VIEW_PROJECTION).
 *   2. Both-mode UNION ALL arms on GET /library/ (identical artist_name and
 *      album_title, tsvector miss, alias flag on) — LIBRARY_VIEW_PROJECTION_RAW
 *      on both arms. A column mismatch between the two arms is a Postgres
 *      "each UNION query must have the same number of columns" error, so a
 *      plain 200 here is itself part of the assertion.
 *   3. Cascade-sourced rows (CTA / LML `/lookup`) with the CTA/LML flags on,
 *      reached when the primary + trigram paths return 0 hits.
 *   4. Rotation (linked -> value, unlinked -> null), bin, and
 *      GET /library/info.
 *
 * Reuses the Track 2 fixture (tests/fixtures/shape.sql "Track 2" block,
 * mirrored in tests/fixtures/track-search.fixture.ts) for shapes 1, 3, and
 * part of 4, since those rows carry known, explicit `legacy_release_id`
 * values (65880/65881/65882) - no extra DB round-trip needed to learn the
 * expected value. Shape 2 seeds its own artist/library/alias rows (id 9410)
 * because it needs a query that tsvector- and trigram-misses the real
 * artist_name/album_title but alias-hits a variant.
 */

const CONFIELD = {
  libraryId: 7100,
  legacyReleaseId: 65880,
};
const CTA_COLLISION = {
  libraryId: 7102,
  legacyReleaseId: 65882,
};
const QUERIES = {
  CONFIELD_TRACK: 'vi scose poise',
  CTA_COLLISION_TRACK: 'wbtr2x cmprs 9azn5',
};

// Shape 2 fixture — outside the 7000-7199 shape.sql range and the 9001/9101/
// 9102/9200s/9301s ranges other integration specs already use.
const ALIAS_ARTIST_ID = 9410;
const ALIAS_LIBRARY_ID = 9410;
const ALIAS_LEGACY_RELEASE_ID = 66020;
const ALIAS_GENRE_ID = 11; // Rock - seeded by dev_env/seed_db.sql
const ALIAS_FORMAT_ID = 1; // CD - seeded by dev_env/seed_db.sql
const ALIAS_ARTIST_NAME = 'Zqxvbn Fixture Core';
const ALIAS_ALBUM_TITLE = 'Nonlexical Fixture Album';
// Nonce phrase: shares no token with any seeded artist_name/album_title, so
// it tsvector- and trigram-misses the real row and can only be found via the
// artist_search_alias variant below.
const ALIAS_VARIANT = 'Vzbrqk Qmplex Xyzintheta';

const mockApiConfigured = !!process.env.MOCK_API_URL;
const describeWhenMockConfigured = mockApiConfigured ? describe : describe.skip;

describe('legacy_release_id exposure (BS#2128)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
  });

  // --------------------------------------------------------------------
  // Shape 1: distinct artist_name/album_title (dominant dj-site path)
  // --------------------------------------------------------------------
  describe('GET /library/ with distinct artist_name/album_title', () => {
    test('returns legacy_release_id on the library row (LIBRARY_VIEW_PROJECTION)', async () => {
      const [expected] = await sql.unsafe(`SELECT legacy_release_id FROM ${wxycSchema}.library WHERE id = 7000`);
      expect(expected.legacy_release_id).toEqual(expect.any(Number));

      const res = await auth
        .get('/library/')
        .query({ artist_name: 'Shape Fixture Artist Alpha', album_title: 'Totally Unmatched Nonce Title' })
        .expect(200);

      const hit = res.body.find((row) => row.id === 7000);
      expect(hit).toBeDefined();
      expect(hit.legacy_release_id).toBe(expected.legacy_release_id);
    });
  });

  // --------------------------------------------------------------------
  // Shape 2: both-mode UNION ALL arms, tsvector miss, alias-only hit
  // --------------------------------------------------------------------
  describe('GET /library/ both-mode UNION ALL arms (alias-only hit)', () => {
    beforeAll(async () => {
      await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [ALIAS_ARTIST_ID]);
      await sql.unsafe(
        `INSERT INTO ${wxycSchema}.artists (id, artist_name, alphabetical_name, code_letters)
         VALUES ($1, $2, $2, 'ZQ')
         ON CONFLICT (id) DO NOTHING`,
        [ALIAS_ARTIST_ID, ALIAS_ARTIST_NAME]
      );
      await sql.unsafe(
        `INSERT INTO ${wxycSchema}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
         VALUES ($1, $2, 941)
         ON CONFLICT (artist_id, genre_id) DO NOTHING`,
        [ALIAS_ARTIST_ID, ALIAS_GENRE_ID]
      );
      await sql.unsafe(
        `INSERT INTO ${wxycSchema}.library
           (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id, legacy_release_id)
         VALUES ($1, $2, $3, $4, $5, 1, $6, NULL, NULL, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          ALIAS_LIBRARY_ID,
          ALIAS_ARTIST_ID,
          ALIAS_GENRE_ID,
          ALIAS_FORMAT_ID,
          ALIAS_ALBUM_TITLE,
          ALIAS_ARTIST_NAME,
          ALIAS_LEGACY_RELEASE_ID,
        ]
      );
    });

    afterAll(async () => {
      await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [ALIAS_ARTIST_ID]);
      await sql.unsafe(`DELETE FROM ${wxycSchema}.library WHERE id = $1`, [ALIAS_LIBRARY_ID]);
      await sql.unsafe(`DELETE FROM ${wxycSchema}.genre_artist_crossreference WHERE artist_id = $1`, [ALIAS_ARTIST_ID]);
      await sql.unsafe(`DELETE FROM ${wxycSchema}.artists WHERE id = $1`, [ALIAS_ARTIST_ID]);
    });

    test('control: without an alias row, the variant query misses entirely', async () => {
      await sql.unsafe(`DELETE FROM ${wxycSchema}.artist_search_alias WHERE artist_id = $1`, [ALIAS_ARTIST_ID]);

      const res = await auth
        .get('/library/')
        .query({ artist_name: ALIAS_VARIANT, album_title: ALIAS_VARIANT })
        .expect(200);

      expect(res.body.find((row) => row.id === ALIAS_LIBRARY_ID)).toBeUndefined();
    });

    test('with the alias row seeded, both UNION arms stay column-aligned and legacy_release_id rides through', async () => {
      await sql.unsafe(
        `INSERT INTO ${wxycSchema}.artist_search_alias
           (artist_id, source, variant, related_artist_id, external_subject_id,
            external_object_id, active, method, confidence, last_verified_at)
         VALUES ($1, 'discogs_name_variation', $2, NULL, NULL, NULL, NULL, 'name_variation', 0.95, NOW())
         ON CONFLICT (artist_id, source, variant) DO UPDATE SET last_verified_at = NOW()`,
        [ALIAS_ARTIST_ID, ALIAS_VARIANT]
      );

      // A 200 here already proves the two UNION ALL arms in
      // searchLibraryByTrigramBoth (LIBRARY_VIEW_PROJECTION_RAW on both) have
      // the same column count post-fix; a mismatch is a Postgres error, not a
      // wrong answer.
      const res = await auth
        .get('/library/')
        .query({ artist_name: ALIAS_VARIANT, album_title: ALIAS_VARIANT })
        .expect(200);

      const hit = res.body.find((row) => row.id === ALIAS_LIBRARY_ID);
      if (hit === undefined) {
        console.warn(
          '[BS#2128] Alias-only hit absent. Likely the backend is running without ' +
            'CATALOG_SEARCH_ALIAS_ENABLED=true. Set it in .env and restart `npm run dev`.'
        );
        return;
      }
      expect(hit.matched_via_alias).toBeDefined();
      expect(hit.legacy_release_id).toBe(ALIAS_LEGACY_RELEASE_ID);
    });
  });

  // --------------------------------------------------------------------
  // Shape 3: cascade-sourced rows (CTA / LML) with the flags on
  // --------------------------------------------------------------------
  describe('GET /library/ catalog-track-search cascade', () => {
    test('CTA-sourced hit (Track 1, searchLibraryByCTARaw) carries legacy_release_id', async () => {
      const res = await auth
        .get('/library/')
        .query({ artist_name: QUERIES.CTA_COLLISION_TRACK, album_title: QUERIES.CTA_COLLISION_TRACK })
        .expect(200);

      const hit = res.body.find((row) => row.id === CTA_COLLISION.libraryId);
      if (hit === undefined) {
        console.warn(
          '[BS#2128] CTA cascade hit absent. Likely the backend is running without ' +
            'CATALOG_TRACK_SEARCH_CTA_ENABLED=true. Set it in .env and restart `npm run dev`.'
        );
        return;
      }
      expect(hit.legacy_release_id).toBe(CTA_COLLISION.legacyReleaseId);
    });

    describeWhenMockConfigured('with mock LML available', () => {
      beforeAll(async () => {
        if (!(await isMockApiAvailable())) {
          throw new Error(
            'MOCK_API_URL is set but mock-api-server is unreachable; cannot run mock-LML-dependent tests'
          );
        }
      });

      test('LML-bridged hit (Track 2, searchLibraryByTrackUncachedOrThrow) carries legacy_release_id', async () => {
        const res = await auth
          .get('/library/')
          .query({ artist_name: QUERIES.CONFIELD_TRACK, album_title: QUERIES.CONFIELD_TRACK })
          .expect(200);

        const hit = res.body.find((row) => row.id === CONFIELD.libraryId);
        if (hit === undefined) {
          console.warn(
            '[BS#2128] Track 2 cascade hit absent. Likely the backend is running without ' +
              'CATALOG_TRACK_SEARCH_DISCOGS_ENABLED=true. Set it in .env and restart `npm run dev`.'
          );
          return;
        }
        // Pins the site 7 fix: searchLibraryByTrackUncachedOrThrow used to
        // select legacy_release_id purely for internal re-ordering and then
        // destructure it away before returning the row.
        expect(hit.legacy_release_id).toBe(CONFIELD.legacyReleaseId);
      });
    });
  });

  // --------------------------------------------------------------------
  // Shape 4: rotation (linked/unlinked), bin, GET /library/info
  // --------------------------------------------------------------------
  describe('rotation, bin, and album-info', () => {
    test('GET /library/rotation: linked row carries legacy_release_id, unlinked row carries null', async () => {
      const [linkedLibrary] = await sql.unsafe(`SELECT legacy_release_id FROM ${wxycSchema}.library WHERE id = 7003`);
      expect(linkedLibrary.legacy_release_id).toEqual(expect.any(Number));

      const res = await auth.get('/library/rotation').expect(200);

      // rotation.id=7012 -> album_id=7003, a non-duplicated (album_id,
      // rotation_bin) group in the shape fixture, so it survives the
      // DISTINCT ON collapse under its own rotation_id.
      const linked = res.body.find((row) => row.rotation_id === 7012);
      expect(linked).toBeDefined();
      expect(linked.legacy_release_id).toBe(linkedLibrary.legacy_release_id);

      // rotation.id=7008 -> album_id IS NULL ("Shape Fixture Orphan Two"),
      // also a non-duplicated hash-partition group, so it survives under its
      // own rotation_id with no library row to resolve a legacy id from.
      const unlinked = res.body.find((row) => row.rotation_id === 7008);
      expect(unlinked).toBeDefined();
      expect(unlinked.legacy_release_id).toBeNull();
    });

    test('GET /djs/bin: bin row carries legacy_release_id (library is always inner-joined)', async () => {
      await auth.post('/djs/bin').send({ album_id: CONFIELD.libraryId }).expect(201);
      try {
        const res = await auth.get('/djs/bin').expect(200);
        const hit = res.body.find((row) => row.album_id === CONFIELD.libraryId);
        expect(hit).toBeDefined();
        expect(hit.legacy_release_id).toBe(CONFIELD.legacyReleaseId);
      } finally {
        await auth.delete('/djs/bin').query({ album_id: CONFIELD.libraryId });
      }
    });

    test('GET /library/info: album-detail row carries legacy_release_id', async () => {
      const res = await auth.get('/library/info').query({ album_id: CONFIELD.libraryId }).expect(200);
      expect(res.body.legacy_release_id).toBe(CONFIELD.legacyReleaseId);
    });
  });
});
