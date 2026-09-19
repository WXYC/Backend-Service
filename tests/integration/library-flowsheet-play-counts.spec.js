/**
 * Integration tests for GET /library/:id/flowsheet-play-counts (BS#2592).
 *
 * The pre-delete read `DELETE /library/:id` needs but cannot answer on its
 * own response — see that route's app.yaml description. Covers the three
 * disjoint arms `deleteAlbumFromDB` used to count before BS#2565 removed the
 * refusal they fed:
 *   - direct (`flowsheet.album_id`)
 *   - rotation-linked (`flowsheet.rotation_id` -> `rotation.album_id`, with
 *     `album_id` NULL — the routine shape the tubafrenzy webhook produces
 *     when it resolves the two columns independently)
 *   - legacy-linked (bare `flowsheet.legacy_release_id`, excluding both
 *     other arms), including a release whose ONLY plays are legacy-linked
 * and asserts they are never summed, that a 404 on an unknown id, and that
 * `GET /library/info` gained no new fields from this work.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('GET /library/:id/flowsheet-play-counts (BS#2592)', () => {
  let auth;
  let sql;
  const uniq = Date.now();
  const createdAlbumIds = [];

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) {
      try {
        if (createdAlbumIds.length > 0) {
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".flowsheet
              WHERE legacy_release_id IN (SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = ANY($1::int[]))`,
            [createdAlbumIds]
          );
          await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = ANY($1::int[])`, [createdAlbumIds]);
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".flowsheet
              WHERE rotation_id IN (SELECT id FROM "${SCHEMA}".rotation WHERE album_id = ANY($1::int[]))`,
            [createdAlbumIds]
          );
          await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1::int[])`, [createdAlbumIds]);
        }
      } finally {
        await sql.end();
      }
    }
  });

  const createAlbum = async (title) => {
    const res = await auth
      .post('/library')
      .send({
        album_title: title,
        artist_name: 'Built to Spill',
        label: `BS#2592 Play Counts Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    createdAlbumIds.push(res.body.id);
    return res.body;
  };

  test('returns 404 for an unknown id', async () => {
    await auth.get('/library/99999999/flowsheet-play-counts').expect(404);
  });

  test('reports the three arms separately, never summed, for a release referenced all three ways', async () => {
    const album = await createAlbum(`BS#2592 Three Arms ${uniq}`);
    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;

    // Direct: album_id set.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9800, 'Built to Spill', $2, 'direct probe')`,
      [album.id, `BS#2592 Three Arms ${uniq}`]
    );

    // Rotation-linked: album_id NULL, reached only via the rotation entry —
    // the routine shape the tubafrenzy webhook produces.
    const rotationRows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
      [album.id]
    );
    const rotationId = rotationRows[0].id;
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (rotation_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9801, 'Built to Spill', $2, 'rotation probe')`,
      [rotationId, `BS#2592 Three Arms ${uniq}`]
    );

    // Legacy-linked: named only by the bare legacy id, both other columns NULL.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9802, 'Built to Spill', $2, 'legacy probe')`,
      [legacyReleaseId, `BS#2592 Three Arms ${uniq}`]
    );

    const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
    expect(res.body).toEqual({ direct: 1, rotation_linked: 1, legacy_linked: 1 });
    // No summed total anywhere in the payload — pinned so a future change
    // can't quietly add one back.
    expect(Object.keys(res.body).sort()).toEqual(['direct', 'legacy_linked', 'rotation_linked']);

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
      `BS#2592 Three Arms ${uniq}`,
    ]);
  });

  test("a play carrying both album_id and one of the release's rotation ids is counted once, as direct", async () => {
    const album = await createAlbum(`BS#2592 Both Paths ${uniq}`);
    const rotationRows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
      [album.id]
    );

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, rotation_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, $2, 'track', 9803, 'Built to Spill', $3, 'both-paths probe')`,
      [album.id, rotationRows[0].id, `BS#2592 Both Paths ${uniq}`]
    );

    const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
    expect(res.body).toEqual({ direct: 1, rotation_linked: 0, legacy_linked: 0 });

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
      `BS#2592 Both Paths ${uniq}`,
    ]);
  });

  test('reports legacy_linked for a release whose ONLY plays are legacy-linked', async () => {
    const album = await createAlbum(`BS#2592 Legacy Only ${uniq}`);
    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9804, 'Built to Spill', $2, 'legacy-only probe')`,
      [legacyReleaseId, `BS#2592 Legacy Only ${uniq}`]
    );

    const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
    expect(res.body).toEqual({ direct: 0, rotation_linked: 0, legacy_linked: 1 });

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
      `BS#2592 Legacy Only ${uniq}`,
    ]);
  });

  test('returns all zeros for an unreferenced release', async () => {
    const album = await createAlbum(`BS#2592 Zero ${uniq}`);
    const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
    expect(res.body).toEqual({ direct: 0, rotation_linked: 0, legacy_linked: 0 });
  });

  // Acceptance criterion: adding these counts to GET /library/info is the
  // tempting wrong answer (that route is catalog:read and the tubafrenzy
  // permalink front door). This pins that it stayed unchanged.
  test('does not add these fields to GET /library/info', async () => {
    const album = await createAlbum(`BS#2592 Info Unchanged ${uniq}`);
    const res = await auth.get('/library/info').query({ album_id: album.id }).expect(200);
    expect(res.body).not.toHaveProperty('direct');
    expect(res.body).not.toHaveProperty('rotation_linked');
    expect(res.body).not.toHaveProperty('legacy_linked');
  });
});
