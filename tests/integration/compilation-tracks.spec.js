const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { isMockApiAvailable } = require('../utils/mock_api');

/**
 * Integration tests for the compilation-track (CTA) write path — BS#1964,
 * Phase 3.5 `/wxycdb` cutover (contract: wxyc-shared api.yaml v1.28.0).
 *
 *   GET  /library/:id/compilation-tracks                     — list stored rows
 *   POST /library/:id/compilation-tracks                     — additive write
 *   GET  /library/:id/compilation-tracks/discogs-suggestions — autopopulate read
 *
 * `{id}` is the serial `library.id`. Fixture library rows come from
 * tests/fixtures/shape.sql: 7000 carries 3 seeded CTA rows; 7009/7001/7003 are
 * valid library rows with no seeded CTA. The discogs-suggestions read composes
 * `library_identity` (BS PG) + LML's /api/v1/discogs/release/{id} (mock LML);
 * the V/A release fixture 5559001 (with populated per-track `artists`) lives at
 * dev_env/mock-api-server/src/fixtures/lml.json. This spec bridges the missing
 * `library_identity` row, exercises the endpoints, and cleans up.
 */

const CTA_SEEDED_LIBRARY_ID = 7000; // shape.sql seeds 3 CTA rows here
const WRITE_LIBRARY_ID = 7009; // valid library row, no seeded CTA (write target)
const SUGGEST_LIBRARY_ID = 7001; // valid library row, bridged to the mock V/A release here
const NO_IDENTITY_LIBRARY_ID = 7003; // valid library row, no library_identity
const ABSENT_LIBRARY_ID = 99999999; // no library row
const MOCK_VA_RELEASE_ID = 5559001; // V/A comp fixture w/ per-track artists (mock lml.json)

// See library-tracks.spec.js: `describe.skip` (not an in-test early return) on
// the mock-requiring block so an unconfigured environment doesn't silently pass.
const mockApiConfigured = !!process.env.MOCK_API_URL;
const describeWhenMockConfigured = mockApiConfigured ? describe : describe.skip;

describe('Compilation-track (CTA) write path (BS#1964)', () => {
  let auth;
  let sql;
  const wxycSchema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
  });

  const cleanupCta = async (libraryId) =>
    sql.unsafe(`DELETE FROM ${wxycSchema}.compilation_track_artist WHERE library_id = $1`, [libraryId]);

  describe('GET /library/:id/compilation-tracks', () => {
    test('lists the stored CTA rows for a shape-seeded library row (7000)', async () => {
      const res = await auth.get(`/library/${CTA_SEEDED_LIBRARY_ID}/compilation-tracks`).expect(200);
      expect(res.body.library_id).toBe(CTA_SEEDED_LIBRARY_ID);
      expect(Array.isArray(res.body.tracks)).toBe(true);
      expect(res.body.tracks.length).toBeGreaterThanOrEqual(3);
      const names = res.body.tracks.map((t) => t.artist_name);
      expect(names).toEqual(
        expect.arrayContaining([
          'Shape Fixture Comp Guest Alpha',
          'Shape Fixture Comp Guest Beta',
          'Shape Fixture Comp Guest Gamma',
        ])
      );
      res.body.tracks.forEach((t) => {
        expect(typeof t.id).toBe('number');
        expect(typeof t.artist_name).toBe('string');
        expect(t.track_title === null || typeof t.track_title === 'string').toBe(true);
        expect(t.track_position === null || typeof t.track_position === 'string').toBe(true);
      });
    });

    test('returns 404 for a library id with no row', async () => {
      const res = await auth.get(`/library/${ABSENT_LIBRARY_ID}/compilation-tracks`).expect(404);
      expect(res.body.message ?? res.body.error ?? '').toMatch(/not found/i);
    });

    test('returns 400 for a non-numeric id', async () => {
      await auth.get('/library/not-a-number/compilation-tracks').expect(400);
    });
  });

  describe('POST /library/:id/compilation-tracks (additive write)', () => {
    afterEach(async () => {
      await cleanupCta(WRITE_LIBRARY_ID);
    });

    test('inserts new rows, reports inserted/skipped, and re-POST is idempotent', async () => {
      const body = {
        tracks: [
          { artist_name: 'CTA Write Guest One', track_title: 'Aurora Ostinato', track_position: 'A1' },
          { artist_name: 'CTA Write Guest Two', track_title: 'Petrichor Drift', track_position: 'A2' },
        ],
      };
      const first = await auth.post(`/library/${WRITE_LIBRARY_ID}/compilation-tracks`).send(body).expect(200);
      expect(first.body.library_id).toBe(WRITE_LIBRARY_ID);
      expect(first.body.inserted).toBe(2);
      expect(first.body.skipped).toBe(0);
      expect(first.body.tracks.length).toBe(2);

      // Additive + idempotent: re-POSTing the same list skips all, mutates none.
      const second = await auth.post(`/library/${WRITE_LIBRARY_ID}/compilation-tracks`).send(body).expect(200);
      expect(second.body.inserted).toBe(0);
      expect(second.body.skipped).toBe(2);
      expect(second.body.tracks.length).toBe(2);
    });

    test('counts intra-batch duplicates as skipped (inserted + skipped == input rows)', async () => {
      const dup = { artist_name: 'CTA Dup Guest', track_title: 'Echo Twice', track_position: 'B1' };
      const res = await auth
        .post(`/library/${WRITE_LIBRARY_ID}/compilation-tracks`)
        .send({ tracks: [dup, dup] })
        .expect(200);
      expect(res.body.inserted).toBe(1);
      expect(res.body.skipped).toBe(1);
      expect(res.body.inserted + res.body.skipped).toBe(2);
      expect(res.body.tracks.filter((t) => t.artist_name === 'CTA Dup Guest').length).toBe(1);
    });

    // BS#1990 (#801 S1) migration 0139 drops `cta_unique_null_track_idx`
    // (BS#1135 / 0099) — the S0/#1989 prod audit measured zero rows in the
    // slice it protected, so `writeCompilationTracks`'s untargeted
    // `ON CONFLICT DO NOTHING` no longer has a NULL-track-title constraint to
    // arbiter on. Both rows now land, matching
    // tests/integration/cta-unique-null-track-partial.spec.js's "now ALLOWED"
    // assertion for the same underlying DB behavior.
    test('intra-batch NULL-track duplicates are no longer deduped (0099 index dropped by 0139)', async () => {
      const dup = { artist_name: 'CTA Null-Track Guest' };
      const res = await auth
        .post(`/library/${WRITE_LIBRARY_ID}/compilation-tracks`)
        .send({ tracks: [dup, dup] })
        .expect(200);
      expect(res.body.inserted).toBe(2);
      expect(res.body.skipped).toBe(0);
      const stored = res.body.tracks.filter((t) => t.artist_name === 'CTA Null-Track Guest');
      expect(stored.length).toBe(2);
      stored.forEach((t) => expect(t.track_title).toBeNull());
    });

    test('returns 400 for an empty track list', async () => {
      await auth.post(`/library/${WRITE_LIBRARY_ID}/compilation-tracks`).send({ tracks: [] }).expect(400);
    });

    test('returns 400 for a blank artist_name', async () => {
      await auth
        .post(`/library/${WRITE_LIBRARY_ID}/compilation-tracks`)
        .send({ tracks: [{ artist_name: '   ', track_title: 'x' }] })
        .expect(400);
    });

    test('returns 404 for a library id with no row', async () => {
      await auth
        .post(`/library/${ABSENT_LIBRARY_ID}/compilation-tracks`)
        .send({ tracks: [{ artist_name: 'Nobody' }] })
        .expect(404);
    });
  });

  describe('GET /library/:id/compilation-tracks/discogs-suggestions', () => {
    test('returns 200 + null release + empty tracks when the row has no library_identity', async () => {
      const res = await auth
        .get(`/library/${NO_IDENTITY_LIBRARY_ID}/compilation-tracks/discogs-suggestions`)
        .expect(200);
      expect(res.body).toEqual({
        library_id: NO_IDENTITY_LIBRARY_ID,
        discogs_release_id: null,
        tracks: [],
      });
    });

    test('returns 404 for a library id with no row', async () => {
      await auth.get(`/library/${ABSENT_LIBRARY_ID}/compilation-tracks/discogs-suggestions`).expect(404);
    });

    describeWhenMockConfigured('with mock LML available (resolves a V/A release tracklist)', () => {
      beforeAll(async () => {
        if (!(await isMockApiAvailable())) {
          throw new Error(
            'MOCK_API_URL is set but mock-api-server is unreachable; cannot run mock-LML-dependent tests'
          );
        }
        await sql.unsafe(
          `INSERT INTO ${wxycSchema}.library_identity
             (library_id, discogs_release_id, last_verified_at, method, confidence)
           VALUES ($1, $2, NOW(), 'integration-test', 0.95)
           ON CONFLICT (library_id) DO UPDATE
             SET discogs_release_id = EXCLUDED.discogs_release_id`,
          [SUGGEST_LIBRARY_ID, MOCK_VA_RELEASE_ID]
        );
      });

      afterAll(async () => {
        await sql.unsafe(`DELETE FROM ${wxycSchema}.library_identity WHERE library_id = $1`, [SUGGEST_LIBRARY_ID]);
      });

      test('flattens per-track artists onto write-ready CompilationTrackInput rows', async () => {
        const res = await auth.get(`/library/${SUGGEST_LIBRARY_ID}/compilation-tracks/discogs-suggestions`).expect(200);
        expect(res.body.library_id).toBe(SUGGEST_LIBRARY_ID);
        expect(res.body.discogs_release_id).toBe(MOCK_VA_RELEASE_ID);
        expect(res.body.tracks.length).toBe(4);
        // per-track single artist, position + title passed through
        expect(res.body.tracks[0]).toEqual({
          artist_name: 'Juana Molina',
          track_title: 'La Paradoja',
          track_position: '1',
        });
        // multi-artist track joins on ', '
        expect(res.body.tracks[2].artist_name).toBe('Chuquimamani-Condori, DJ E');
        // empty per-track artists -> release-level fallback ("Various")
        expect(res.body.tracks[3].artist_name).toBe('Various');
        res.body.tracks.forEach((t) => {
          expect(typeof t.artist_name).toBe('string');
          expect(t.artist_name.length).toBeGreaterThan(0);
        });
      });

      test('suggestions are read-only (do not write CTA rows)', async () => {
        await auth.get(`/library/${SUGGEST_LIBRARY_ID}/compilation-tracks/discogs-suggestions`).expect(200);
        const listed = await auth.get(`/library/${SUGGEST_LIBRARY_ID}/compilation-tracks`).expect(200);
        expect(listed.body.tracks.length).toBe(0);
      });
    });
  });
});
