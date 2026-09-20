/**
 * Integration tests for POST /library/deleted/:batchId/restore (BS#2585 / F2b)
 * -- the write half of the `catalog_delete_snapshot` archive whose read half is
 * covered by library-deleted-archive.spec.js and whose capture is covered by
 * library-delete.spec.js.
 *
 * These four properties need a migrated Postgres and cannot be reached by the
 * unit tier, which mocks the driver:
 *
 *   1. the FK-ordered replay actually satisfies the real constraints -- a
 *      `rotation_urls` row landing before its `rotation` parent is a 23503 no
 *      mocked transaction can raise;
 *   2. both arms of the reissued-code resolution against a real occupied slot,
 *      and the genre-scoped slot key against a real row filed under the same
 *      artist and code number in a DIFFERENT genre (the 3,035-false-positive
 *      case a genre-blind predicate would relocate);
 *   3. an ambiguous request is refused, and refused WITHOUT WRITING -- proven
 *      by reading the catalog back, not by trusting the status code;
 *   4. a failed replay rolls the entire batch back, leaving no observable
 *      partial restore.
 *
 * `catalog_delete_snapshot` is permanently retained and this suite shares a
 * database with every other integration spec, so every fixture is scoped to a
 * per-run unique marker and every assertion is scoped to the ids this run
 * created.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ROCK = 11;
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

describe('POST /library/deleted/:batchId/restore (BS#2585)', () => {
  let auth;
  let sql;
  const uniq = Date.now();
  const marker = `BS#2585 Restore ${uniq}`;
  const artistName = `${marker} Artist`;
  const touchedAlbumIds = [];
  const deletedArtistIds = [];
  let artistId;
  let unrestorableSeq = 0;

  /**
   * Creates and immediately deletes a fresh artist so its
   * `catalog_delete_snapshot` row is `entity_kind = 'artist'` -- a genuine
   * batch BS#2616's replay plan has no entry for, sourced the same way
   * `library-delete-artist.spec.js` does rather than hand-inserted.
   */
  const createAndDeleteArtistBatch = async () => {
    unrestorableSeq += 1;
    const codeLetters = `${uniq.toString(36).toUpperCase().slice(-2)}Z${unrestorableSeq}`.slice(0, 4);
    const created = await auth
      .post('/library/artists')
      .send({ artist_name: `${marker} Unrestorable ${unrestorableSeq}`, code_letters: codeLetters, genre_id: ROCK })
      .expect(201);
    deletedArtistIds.push(created.body.id);
    await auth.delete(`/library/artists/${created.body.id}`).expect(204);
    const rows = await sql.unsafe(
      `SELECT batch_id FROM "${SCHEMA}".catalog_delete_snapshot
        WHERE entity_kind = 'artist' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [created.body.id]
    );
    expect(rows).toHaveLength(1);
    return { artistId: created.body.id, batchId: rows[0].batch_id };
  };

  /** The batch id the delete of `albumId` wrote, read straight out of the archive table. */
  const batchIdFor = async (albumId) => {
    const rows = await sql.unsafe(
      `SELECT batch_id FROM "${SCHEMA}".catalog_delete_snapshot
        WHERE entity_kind = 'library' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [albumId]
    );
    expect(rows).toHaveLength(1);
    return rows[0].batch_id;
  };

  const libraryRow = async (albumId) => {
    const rows = await sql.unsafe(
      `SELECT id, artist_id, genre_id, code_number, code_volume_letters, album_title, legacy_release_id
         FROM "${SCHEMA}".library WHERE id = $1`,
      [albumId]
    );
    return rows[0] ?? null;
  };

  const createAlbum = async (overrides = {}) => {
    const created = await auth
      .post('/library')
      .send({
        album_title: `${marker} Release`,
        artist_id: artistId,
        label: marker,
        genre_id: ROCK,
        format_id: FMT,
        ...overrides,
      })
      .expect(201);
    touchedAlbumIds.push(created.body.id);
    return created.body;
  };

  const deleteAlbum = async (albumId) => {
    await auth.delete(`/library/${albumId}`).expect(204);
    return batchIdFor(albumId);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // A `uniq`-suffixed artist with an explicit `code_number`, same recipe as
    // library-deleted-archive.spec.js: `POST /library` resolves `artist_name`
    // by a genre-scoped exact lookup, so a made-up name would 400.
    const artist = await auth
      .post('/library/artists')
      .send({ artist_name: artistName, code_letters: 'B8', genre_id: ROCK, code_number: 8000 + (uniq % 500) })
      .expect(201);
    artistId = artist.body.id;
  });

  afterAll(async () => {
    if (!sql) return;
    try {
      if (touchedAlbumIds.length > 0) {
        // Restored rows are real catalog rows again, so this teardown has to
        // remove them -- unlike the read-half spec, where every album was
        // already deleted through the API. Children first: `bins` and
        // `artist_library_crossreference` have no `onDelete` on their FK.
        await sql.unsafe(`DELETE FROM "${SCHEMA}".bins WHERE album_id = ANY($1::int[])`, [touchedAlbumIds]);
        await sql.unsafe(`DELETE FROM "${SCHEMA}".artist_library_crossreference WHERE library_id = ANY($1::int[])`, [
          touchedAlbumIds,
        ]);
        await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1::int[])`, [touchedAlbumIds]);
        await sql.unsafe(
          `DELETE FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY($1::int[])`,
          [touchedAlbumIds]
        );
        await sql.unsafe(`DELETE FROM "${SCHEMA}".library_delete_denylist WHERE library_id = ANY($1::int[])`, [
          touchedAlbumIds,
        ]);
      }
      if (deletedArtistIds.length > 0) {
        // These artists are already hard-deleted by their own DELETE call --
        // only their archive rows need cleaning up.
        await sql.unsafe(
          `DELETE FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'artist' AND entity_id = ANY($1::int[])`,
          [deletedArtistIds]
        );
      }
    } finally {
      await sql.end();
    }
  });

  test('replays the release under its own id and lifts the ETL re-import block', async () => {
    const album = await createAlbum({ album_title: `${marker} Plain` });
    const before = await libraryRow(album.id);
    const batchId = await deleteAlbum(album.id);
    expect(await libraryRow(album.id)).toBeNull();

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.batch_id).toBe(batchId);
    expect(res.body.entities).toHaveLength(1);
    expect(res.body.entities[0]).toMatchObject({
      entity_kind: 'library',
      entity_id: album.id,
      table: 'library',
      relocated_code_number: null,
    });

    // Back under the SAME primary key, with the same call number and the same
    // legacy id -- which is what keeps every captured child FK valid.
    const after = await libraryRow(album.id);
    expect(after).toMatchObject({
      id: before.id,
      artist_id: before.artist_id,
      genre_id: before.genre_id,
      code_number: before.code_number,
      album_title: before.album_title,
      legacy_release_id: before.legacy_release_id,
    });

    // A surviving denylist row would make `jobs/library-etl`'s
    // `reconcileDenylistedInserts` report this restore as a stranded
    // resurrection and exit non-zero on every run.
    const denylist = await sql.unsafe(
      `SELECT 1 FROM "${SCHEMA}".library_delete_denylist WHERE legacy_release_id = $1`,
      [before.legacy_release_id]
    );
    expect(denylist).toHaveLength(0);

    // The archive row is NOT consumed: retention is permanent, and the card's
    // original code has to stay readable afterwards.
    const archived = await sql.unsafe(
      `SELECT captured->'entity'->'row'->>'code_number' AS code FROM "${SCHEMA}".catalog_delete_snapshot
        WHERE batch_id = $1`,
      [batchId]
    );
    expect(archived).toHaveLength(1);
    expect(Number(archived[0].code)).toBe(before.code_number);
  });

  test('replays children in FK order, grandchildren after their own parents', async () => {
    const album = await createAlbum({ album_title: `${marker} Subtree` });

    // `rotation` + `rotation_urls` and `artist_library_crossreference` are the
    // depth-2 and depth-1 shapes the replay order has to get right. Written
    // directly so the fixture does not depend on the rotation write path's own
    // validation rules.
    const rotation = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin, add_date) VALUES ($1, 'H', now()) RETURNING id`,
      [album.id]
    );
    const rotationId = rotation[0].id;
    // `position` is NOT NULL with no default and carries a unique index with
    // `rotation_id`; production writes it as the array index (`urls.map((url,
    // position) => ...)`), so a lone URL is 0.
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation_urls (rotation_id, url, position) VALUES ($1, $2, $3)`, [
      rotationId,
      `https://example.test/${uniq}`,
      0,
    ]);
    await sql.unsafe(`INSERT INTO "${SCHEMA}".artist_library_crossreference (artist_id, library_id) VALUES ($1, $2)`, [
      artistId,
      album.id,
    ]);

    const batchId = await deleteAlbum(album.id);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].children).toMatchObject({
      rotation: 1,
      rotation_urls: 1,
      artist_library_crossreference: 1,
    });

    // The FK actually resolves after the replay: `rotation_urls.rotation_id`
    // references `rotation.id`, so a parent written second would have raised
    // 23503 and rolled the whole batch back instead of answering 200.
    const urls = await sql.unsafe(
      `SELECT u.id FROM "${SCHEMA}".rotation_urls u
         JOIN "${SCHEMA}".rotation r ON r.id = u.rotation_id
        WHERE r.album_id = $1`,
      [album.id]
    );
    expect(urls).toHaveLength(1);
  });

  test('refuses an ambiguous request with a 400 and writes nothing', async () => {
    const album = await createAlbum({ album_title: `${marker} Taken` });
    const before = await libraryRow(album.id);
    const batchId = await deleteAlbum(album.id);

    // Re-occupy the exact slot, in the same genre.
    const squatter = await createAlbum({
      album_title: `${marker} Squatter`,
      code_number: before.code_number,
    });
    expect((await libraryRow(squatter.id)).code_number).toBe(before.code_number);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(400);

    expect(res.body.reason).toBe('resolution_required');
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({
      entity_id: album.id,
      artist_id: artistId,
      genre_id: ROCK,
      code_number: before.code_number,
      occupied_by_library_id: squatter.id,
    });
    expect(res.body.conflicts[0].next_free_code_number).toBeGreaterThan(before.code_number);

    // Refused WITHOUT writing -- read the catalog back rather than trust the
    // status code.
    expect(await libraryRow(album.id)).toBeNull();
  });

  test('declines on request, leaving the card in the archive and the catalog untouched', async () => {
    const album = await createAlbum({ album_title: `${marker} Declined` });
    const before = await libraryRow(album.id);
    const batchId = await deleteAlbum(album.id);
    await createAlbum({ album_title: `${marker} Declined Squatter`, code_number: before.code_number });

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({ resolution: 'decline' }).expect(409);

    expect(res.body.reason).toBe('restore_declined');
    expect(res.body.conflicts).toHaveLength(1);
    expect(await libraryRow(album.id)).toBeNull();

    // Still restorable later: declining must not consume the archive row.
    const archived = await sql.unsafe(`SELECT 1 FROM "${SCHEMA}".catalog_delete_snapshot WHERE batch_id = $1`, [
      batchId,
    ]);
    expect(archived).toHaveLength(1);
  });

  test('files the card at the next free code on that shelf when asked to', async () => {
    const album = await createAlbum({ album_title: `${marker} Relocated` });
    const before = await libraryRow(album.id);
    const batchId = await deleteAlbum(album.id);
    const squatter = await createAlbum({
      album_title: `${marker} Relocated Squatter`,
      code_number: before.code_number,
    });

    const res = await auth
      .post(`/library/deleted/${batchId}/restore`)
      .send({ resolution: 'next_free_code' })
      .expect(200);

    const relocated = res.body.entities[0].relocated_code_number;
    expect(relocated).toBeGreaterThan(before.code_number);

    const after = await libraryRow(album.id);
    expect(after.code_number).toBe(relocated);
    // The slot it could not have: the squatter keeps its own.
    expect((await libraryRow(squatter.id)).code_number).toBe(before.code_number);
    // And the archive still records the ORIGINAL code.
    const archived = await sql.unsafe(
      `SELECT captured->'entity'->'row'->>'code_number' AS code FROM "${SCHEMA}".catalog_delete_snapshot
        WHERE batch_id = $1`,
      [batchId]
    );
    expect(Number(archived[0].code)).toBe(before.code_number);
  });

  /**
   * THE MEASURED CASE. A release filed under the SAME artist and the SAME code
   * number but a DIFFERENT genre is a different physical shelf slot -- code
   * letters are genre-scoped, so `Rock B8 7` and `Electronic B8 7` hold
   * different discs. `albumCodeNumberTaken`'s genre-blind `(artist_id,
   * code_number)` sees 3,308 apparent collisions in production where this key
   * sees 273; this test is one of those 3,035 false positives, and it restores
   * into its own slot with NO relocation.
   */
  test('a same-code release in another genre is not a collision', async () => {
    const album = await createAlbum({ album_title: `${marker} Genre Scoped` });
    const before = await libraryRow(album.id);
    const batchId = await deleteAlbum(album.id);

    // The artist has to exist in the second genre before a release can be
    // filed there; write the crossreference directly rather than depend on the
    // artist-create path's code allocation.
    const otherGenre = ROCK === 11 ? 12 : 11;
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [artistId, otherGenre, 8500 + (uniq % 500)]
    );
    const crossGenre = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [artistId, otherGenre, FMT, `${marker} Other Genre`, before.code_number]
    );
    touchedAlbumIds.push(crossGenre[0].id);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].relocated_code_number).toBeNull();
    expect((await libraryRow(album.id)).code_number).toBe(before.code_number);
  });

  test('a failed replay rolls the whole batch back, leaving no partial restore', async () => {
    const album = await createAlbum({ album_title: `${marker} Rollback` });
    const batchId = await deleteAlbum(album.id);

    // Corrupt exactly one child row in the archive so its INSERT violates a
    // real constraint (`bins.dj_id` references `djs.id`), then assert the
    // PARENT never landed either. A negative id cannot exist in `djs`.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".catalog_delete_snapshot
          SET captured = jsonb_set(
            captured,
            '{children,bins}',
            jsonb_build_array(jsonb_build_object(
              'id', 2147483000,
              'album_id', $2::int,
              'dj_id', -1,
              'artist_name', 'x',
              'album_title', 'x',
              'track_title', 'x'
            ))
          )
        WHERE batch_id = $1`,
      [batchId, album.id]
    );

    await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(500);

    expect(await libraryRow(album.id)).toBeNull();
    const bins = await sql.unsafe(`SELECT 1 FROM "${SCHEMA}".bins WHERE album_id = $1`, [album.id]);
    expect(bins).toHaveLength(0);
  });

  test('refuses an artist batch with a named 409 refusal, agreeing with the listing, and writes nothing', async () => {
    const { artistId: deletedArtistId, batchId } = await createAndDeleteArtistBatch();

    // The listing already said this batch was not restorable, off the same
    // exported set the refusal below reads.
    const listed = await auth
      .get('/library/deleted')
      .query({ search: `Unrestorable ${unrestorableSeq}` })
      .expect(200);
    const batch = listed.body.results.find((candidate) => candidate.batch_id === batchId);
    expect(batch).toBeDefined();
    expect(batch.restorable).toBe(false);

    const snapshotBefore = await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".catalog_delete_snapshot WHERE batch_id = $1`,
      [batchId]
    );

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(409);

    expect(res.body.reason).toBe('unrestorable_kind');
    expect(res.body.entity_kind).toBe('artist');

    // A named refusal, not a 500 -- and it left both the catalog and the
    // archive byte-identical: the artist stays gone, and the snapshot row
    // it never touched is still there for a future reader.
    await auth.get(`/library/artists/${deletedArtistId}`).expect(404);
    const snapshotAfter = await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".catalog_delete_snapshot WHERE batch_id = $1`,
      [batchId]
    );
    expect(snapshotAfter[0].n).toBe(snapshotBefore[0].n);
  });

  test('still raises a 500 for a known-table batch whose captured row is missing, not the named refusal', async () => {
    const album = await createAlbum({ album_title: `${marker} Tampered` });
    const batchId = await deleteAlbum(album.id);

    // `library` passes the restorability check -- this tampers the envelope
    // AFTER that check to prove the two conditions stay distinct: an
    // unsupported kind refuses cleanly, but a supported kind with no
    // captured row is a corrupt envelope and still a bug worth a 500.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".catalog_delete_snapshot SET captured = jsonb_set(captured, '{entity,row}', 'null'::jsonb)
        WHERE batch_id = $1`,
      [batchId]
    );

    await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(500);

    expect(await libraryRow(album.id)).toBeNull();
  });

  test('answers 409 already_restored on a second restore of the same batch', async () => {
    const album = await createAlbum({ album_title: `${marker} Idempotent` });
    const batchId = await deleteAlbum(album.id);

    await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);
    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(409);

    expect(res.body.reason).toBe('already_restored');
    expect(res.body.entity_ids).toEqual([album.id]);
  });

  test('answers 404 for a well-formed batch id nothing was captured under', async () => {
    await auth.post('/library/deleted/00000000-0000-4000-8000-000000000000/restore').send({}).expect(404);
  });

  test('answers 400 for a non-UUID batch id and for an unrecognized resolution', async () => {
    await auth.post('/library/deleted/not-a-uuid/restore').send({}).expect(400);
    const album = await createAlbum({ album_title: `${marker} Bad Arm` });
    const batchId = await deleteAlbum(album.id);
    await auth.post(`/library/deleted/${batchId}/restore`).send({ resolution: 'relocate_silently' }).expect(400);
  });

  test('a request with no Authorization header is rejected', async () => {
    await request.post('/library/deleted/00000000-0000-4000-8000-000000000000/restore').send({}).expect(401);
  });
});
