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
 *
 * Also covers the shape a single-arm-per-row fixture can't exercise: the
 * tubafrenzy webhook (`apps/backend/routes/internal.route.ts`) resolves
 * `album_id`, `rotation_id` and `legacy_release_id` together in one INSERT,
 * so a real row routinely carries the bare legacy id ALONGSIDE a resolved
 * album_id or rotation_id. The "direct plus legacy" / "rotation plus legacy"
 * / sum-invariant tests reproduce that overlap and would fail if either of
 * legacy_linked's exclusion guards were removed. The "all three columns"
 * test reproduces the single MOST COMMON production shape this webhook
 * produces — every play of an in-library, rotating release resolves all
 * three columns in that same INSERT — which none of the other fixtures set
 * on one row.
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

  // Every fixture above sets exactly ONE of album_id / rotation_id /
  // legacy_release_id per row, so none of them can tell a genuinely disjoint
  // legacy-linked WHERE clause apart from one whose exclusion guards were
  // deleted — all three arms would still read the same numbers either way.
  // Production is NOT that shape: apps/backend/routes/internal.route.ts's
  // tubafrenzy webhook resolves `album_id`, `rotation_id`, and
  // `legacy_release_id` in the SAME INSERT (see its `resolveAlbumId` /
  // `resolveRotationId` calls feeding one `.values({...})`), so a real
  // flowsheet row routinely carries the bare legacy id ALONGSIDE a resolved
  // album_id or rotation_id. These next two tests reproduce that shape.
  test(
    'a play carrying both album_id and legacy_release_id (the tubafrenzy webhook shape) ' +
      'is counted once, as direct, never as legacy_linked',
    async () => {
      const album = await createAlbum(`BS#2592 Direct Plus Legacy ${uniq}`);
      const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
      const legacyReleaseId = before[0].legacy_release_id;

      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, $2, 'track', 9805, 'Built to Spill', $3, 'direct-plus-legacy probe')`,
        [album.id, legacyReleaseId, `BS#2592 Direct Plus Legacy ${uniq}`]
      );

      const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
      // If `getFlowsheetPlayImpact`'s legacy_linked FILTER lost its
      // `flowsheet.album_id IS DISTINCT FROM album_id` exclusion, this row
      // (album_id = the release, legacy_release_id = the release's legacy id)
      // would satisfy BOTH the direct predicate and the legacy predicate, and
      // legacy_linked would read 1 instead of 0 — this assertion catches that.
      expect(res.body).toEqual({ direct: 1, rotation_linked: 0, legacy_linked: 0 });

      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
        `BS#2592 Direct Plus Legacy ${uniq}`,
      ]);
    }
  );

  test(
    "a play carrying both rotation_id (this release's rotation row) and legacy_release_id " +
      '(the tubafrenzy webhook shape) is counted once, as rotation_linked, never as legacy_linked',
    async () => {
      const album = await createAlbum(`BS#2592 Rotation Plus Legacy ${uniq}`);
      const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
      const legacyReleaseId = before[0].legacy_release_id;
      const rotationRows = await sql.unsafe(
        `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
        [album.id]
      );

      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (rotation_id, legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, $2, 'track', 9806, 'Built to Spill', $3, 'rotation-plus-legacy probe')`,
        [rotationRows[0].id, legacyReleaseId, `BS#2592 Rotation Plus Legacy ${uniq}`]
      );

      const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
      // If legacy_linked's rotation-membership exclusion
      // (`flowsheet.rotation_id IS NULL OR ... NOT IN (subquery)`) were
      // deleted, this row's rotation_id (a member of this release's rotation
      // subquery) plus its matching legacy_release_id would satisfy BOTH the
      // rotation predicate and the legacy predicate, and legacy_linked would
      // read 1 instead of 0 — this assertion catches that.
      expect(res.body).toEqual({ direct: 0, rotation_linked: 1, legacy_linked: 0 });

      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
        `BS#2592 Rotation Plus Legacy ${uniq}`,
      ]);
    }
  );

  test(
    'a play carrying album_id, rotation_id, and legacy_release_id together (the full ' +
      'tubafrenzy webhook shape) is counted once, as direct, never as rotation_linked or legacy_linked',
    async () => {
      const album = await createAlbum(`BS#2592 All Three Columns ${uniq}`);
      const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
      const legacyReleaseId = before[0].legacy_release_id;
      const rotationRows = await sql.unsafe(
        `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
        [album.id]
      );

      // apps/backend/routes/internal.route.ts resolves album_id, rotation_id
      // AND legacy_release_id together in one `.values({...})` INSERT
      // (resolveAlbumId + resolveRotationId feeding the same webhook write),
      // so this is not an edge case: it's the shape of every play of an
      // in-library, rotating release. None of the fixtures above set all
      // three columns on one row.
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, rotation_id, legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, $2, $3, 'track', 9807, 'Built to Spill', $4, 'all-three-columns probe')`,
        [album.id, rotationRows[0].id, legacyReleaseId, `BS#2592 All Three Columns ${uniq}`]
      );

      const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
      // direct's `album_id = $albumId` predicate carries no exclusion of its
      // own; rotation_linked and legacy_linked both exclude `album_id IS
      // DISTINCT FROM $albumId`, so a row satisfying all three raw
      // predicates still lands in direct alone.
      expect(res.body).toEqual({ direct: 1, rotation_linked: 0, legacy_linked: 0 });

      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
        `BS#2592 All Three Columns ${uniq}`,
      ]);
    }
  );

  test(
    'the three counts sum to the number of distinct flowsheet rows, across every legacy-linkage ' +
      'overlap shape a production row can take (album_id+rotation_id with no legacy_release_id is ' +
      'a different shape — a live DJ play, never a webhook row — and is covered by its own test above)',
    async () => {
      const title = `BS#2592 Sum Invariant ${uniq}`;
      const album = await createAlbum(title);
      const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
      const legacyReleaseId = before[0].legacy_release_id;
      const rotationRows = await sql.unsafe(
        `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
        [album.id]
      );
      const rotationId = rotationRows[0].id;

      // Six rows, one per legacy_release_id-involving shape a real flowsheet
      // row can take against this release: direct-only, rotation-only,
      // legacy-only, direct+legacy, rotation+legacy, and all-three (every
      // webhook shape, per the tests above). If any pair of arms ever
      // overlapped in the aggregate's FILTER conditions -- the exact defect
      // the disjointness guards exist to prevent -- this sum would exceed 6
      // regardless of whether any single per-arm assertion happened to look
      // right in isolation.
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9810, 'Built to Spill', $2, 'sum: direct-only')`,
        [album.id, title]
      );
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (rotation_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9811, 'Built to Spill', $2, 'sum: rotation-only')`,
        [rotationId, title]
      );
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9812, 'Built to Spill', $2, 'sum: legacy-only')`,
        [legacyReleaseId, title]
      );
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, $2, 'track', 9813, 'Built to Spill', $3, 'sum: direct-plus-legacy')`,
        [album.id, legacyReleaseId, title]
      );
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (rotation_id, legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, $2, 'track', 9814, 'Built to Spill', $3, 'sum: rotation-plus-legacy')`,
        [rotationId, legacyReleaseId, title]
      );
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, rotation_id, legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, $2, $3, 'track', 9815, 'Built to Spill', $4, 'sum: all-three-columns')`,
        [album.id, rotationId, legacyReleaseId, title]
      );

      const res = await auth.get(`/library/${album.id}/flowsheet-play-counts`).expect(200);
      // Exact per-arm breakdown first, so a failure points at which guard
      // broke rather than just "the sum is wrong somehow": direct-only,
      // direct-plus-legacy, and all-three-columns all land in `direct` (3);
      // rotation-only and rotation-plus-legacy both land in
      // `rotation_linked` (2); only legacy-only has no other predicate to
      // satisfy, so `legacy_linked` is 1.
      expect(res.body).toEqual({ direct: 3, rotation_linked: 2, legacy_linked: 1 });
      expect(res.body.direct + res.body.rotation_linked + res.body.legacy_linked).toBe(6);

      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
        title,
      ]);
    }
  );

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

  // The full top-level key set `getAlbumFromDB` produces, after the
  // `serializeReconciledIdentity` / `withDiscogsUnavailableCamelCase`
  // wire-shape transforms in library.service.ts. Sorted so the assertion
  // below doesn't depend on select/spread order.
  const LIBRARY_INFO_FIELDS = [
    'add_date',
    'album_artist',
    'album_title',
    'alphabetical_name',
    'alternate_artist_name',
    'artist_id',
    'artist_name',
    'code_artist_number',
    'code_letters',
    'code_number',
    'code_volume_letters',
    'date_found',
    'date_lost',
    'disc_quantity',
    'discogsUnavailable',
    'discogsUnavailableNote',
    'format_id',
    'format_name',
    'genre_id',
    'genre_name',
    'id',
    'label',
    'label_id',
    'lastDiscogsRecheckAt',
    'last_modified',
    'legacy_release_id',
    'on_streaming',
    'plays',
    'reconciled_identity',
    'record_label',
    'urls',
  ].sort();

  // Acceptance criterion: adding these counts to GET /library/info is the
  // tempting wrong answer (that route is catalog:read and the tubafrenzy
  // permalink front door). Three `not.toHaveProperty(name)` checks only pin
  // three literal spellings — a future change that added the counts nested
  // under some other key (`flowsheet_play_counts`, `play_impact`,
  // `direct_play_count`, ...) would sail through unnoticed. Pinning the
  // entire top-level key set instead means ANY new field, under any name,
  // fails this test — which is what "unchanged" has to mean for a frozen
  // contract.
  test('GET /library/info response shape is unchanged (no new top-level fields of any name)', async () => {
    const album = await createAlbum(`BS#2592 Info Unchanged ${uniq}`);
    const res = await auth.get('/library/info').query({ album_id: album.id }).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(LIBRARY_INFO_FIELDS);
    // Still assert the three specific names directly, so a failure here
    // reads as "the play-impact fields leaked onto /library/info" rather
    // than a generic shape diff a reader has to go decode.
    expect(res.body).not.toHaveProperty('direct');
    expect(res.body).not.toHaveProperty('rotation_linked');
    expect(res.body).not.toHaveProperty('legacy_linked');
  });
});
