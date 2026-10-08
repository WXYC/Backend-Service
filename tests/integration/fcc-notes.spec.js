/**
 * `POST /fcc-notes` and `GET /fcc-notes` (BS#2862, slice 13c of BS#2791), the stamp `POST /intake/{id}/file`
 * gives a note, and confirm, delete and the music directors' waiting list (BS#2863; the delete-against-confirm overlap
 * is tests/integration/fcc-notes-delete-confirm-race.spec.js). Real Postgres, seeded through tests/utils/intake_seed.js. The CI containers run AUTH_BYPASS=true, so
 * the route grants are pinned by tests/unit/routes/fcc-notes-permissions.route.test.ts and the lock order and retry
 * by tests/unit/services/fcc-notes.service.test.ts; this tier pins the SQL against real rows: the record's name read
 * through the joins, the order of a list, the stamp at filing (both arms), the race with a filing, the cascade and
 * the restore. `djA` is a raw user-id Bearer (a non-manager acting as that id).
 *
 * New-release filings mint an artist and leave it behind, as intake-file.spec.js does: a random 4-character code per
 * call keeps reruns from colliding.
 */

const { randomInt } = require('node:crypto');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  removeSeededAuthUsers,
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedAcceptance,
  seedFccNote,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-FCC';
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const uniqueSuffix = () => Array.from({ length: 4 }, () => BASE36[randomInt(BASE36.length)]).join('');
const GENRE = 11;

describe('/fcc-notes (BS#2862)', () => {
  let manager;
  let djA;
  let sql;
  const filedAlbumIds = [];

  const note = (extra) => ({ track: 'la paradoja', note: `${PREFIX} note`, ...extra });
  const noteRows = (column, id) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".fcc_notes WHERE ${column} = $1 ORDER BY reported_at, id`, [id]);
  const pooledItem = (key) =>
    seedIntakeItem({ artist_name: `${PREFIX} ${key}`, album_title: `${PREFIX} ${key} album` });
  /** A `reviewed` item with its own submitted review accepted, which is what filing needs. */
  const reviewedItem = async (key) => {
    const item = await seedIntakeItem({
      artist_name: `${PREFIX} ${key}`,
      album_title: `${PREFIX} ${key} album`,
      state: 'reviewed',
      checked_out_by: global.primary_dj_id,
      checked_out_at: new Date().toISOString(),
    });
    const accepted = await seedReview({ intake_item_id: item.id, author: `${PREFIX} author` });
    await seedAcceptance({ intake_item_id: item.id, review_id: accepted.id });
    return item;
  };
  const fileExisting = (id, album_id) =>
    manager.post(`/intake/${id}/file`).send({ kind: 'existing_release', album_id });
  const fileNew = async (id) => {
    const suffix = uniqueSuffix();
    const res = await manager.post(`/intake/${id}/file`).send({
      kind: 'new_release',
      artist: {
        kind: 'create',
        artist_name: `${PREFIX} Artist ${suffix}`,
        code_letters: suffix,
        genre_id: GENRE,
        code_number: 1,
      },
      release: { album_title: `${PREFIX} Album ${suffix}`, label: 'Test Label', genre_id: GENRE, format_id: 1 },
    });
    if (res.status === 200) filedAlbumIds.push(res.body.album_id);
    return res;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    if (filedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${filedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY(${filedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_delete_denylist WHERE library_id = ANY(${filedAlbumIds})`;
    }
    filedAlbumIds.length = 0;
    await removeSeededLibraryReleases();
    await removeSeededAuthUsers();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  describe('POST /fcc-notes', () => {
    test('a DJ who holds nothing reports against a logged record: reported, under their account name, carrying the item’s record', async () => {
      const item = await pooledItem('item');
      const [{ name }] = await sql.unsafe(`SELECT name FROM auth_user WHERE id = $1`, [global.primary_dj_id]);

      const res = await djA.post('/fcc-notes').send(note({ intake_item_id: item.id, track: '  B2  ' }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        album_id: null,
        intake_item_id: item.id,
        track: 'B2',
        status: 'reported',
        reported_by: name,
        reported_by_user_id: global.primary_dj_id,
        confirmed_by: null,
        confirmed_at: null,
        artist_name: `${PREFIX} item`,
        album_title: `${PREFIX} item album`,
      });
    });

    test('a note on a release carries the release’s artist and title', async () => {
      const release = await seedLibraryRelease({ artist_name: `${PREFIX} Artist`, album_title: `${PREFIX} release` });

      const res = await djA.post('/fcc-notes').send(note({ album_id: release.id }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        album_id: release.id,
        intake_item_id: null,
        artist_name: `${PREFIX} Artist`,
        album_title: `${PREFIX} release`,
      });
    });

    test.each([
      ['both subjects', (item, release) => note({ intake_item_id: item, album_id: release })],
      ['neither subject', () => note()],
      ['a release that does not exist', () => note({ album_id: 2147483647 })],
      ['an item that does not exist', () => note({ intake_item_id: 2147483647 })],
      ['a blank track', (item) => note({ intake_item_id: item, track: '  ' })],
      ['a missing note', (item) => ({ intake_item_id: item, track: 'B2' })],
    ])('%s is a 400 and writes nothing', async (_name, body) => {
      const item = await pooledItem('bad');
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} bad` });
      const before = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".fcc_notes`))[0].n;

      expect((await djA.post('/fcc-notes').send(body(item.id, release.id))).status).toBe(400);

      expect((await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".fcc_notes`))[0].n).toBe(before);
    });

    test('a note against an item that is already filed carries its release at once, and is on the release’s list', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} filed` });
      const item = await seedIntakeItem({ artist_name: PREFIX, state: 'filed', album_id: release.id });

      const res = await djA.post('/fcc-notes').send(note({ intake_item_id: item.id }));

      expect(res.body).toMatchObject({ album_id: release.id, intake_item_id: item.id });
      const listed = await djA.get(`/fcc-notes?album_id=${release.id}`);
      expect(listed.body.map((n) => n.id)).toEqual([res.body.id]);
    });

    test('deleting an item removes its notes', async () => {
      const item = await pooledItem('cascade');
      await djA
        .post('/fcc-notes')
        .send(note({ intake_item_id: item.id }))
        .expect(200);
      expect(await noteRows('intake_item_id', item.id)).toHaveLength(1);

      await manager.delete(`/intake/${item.id}`).expect(200);

      expect(await noteRows('intake_item_id', item.id)).toHaveLength(0);
    });
  });

  describe('GET /fcc-notes', () => {
    test('an item’s list holds both statuses, oldest first', async () => {
      const item = await pooledItem('list');
      const second = await seedFccNote({ intake_item_id: item.id, reported_at: '2026-10-02T12:00:00Z' });
      const first = await seedFccNote({
        intake_item_id: item.id,
        reported_at: '2026-10-01T12:00:00Z',
        status: 'confirmed',
        confirmed_by: 'Test Reviewer',
        confirmed_at: '2026-10-03T12:00:00Z',
      });

      const res = await djA.get(`/fcc-notes?intake_item_id=${item.id}`);

      expect(res.status).toBe(200);
      expect(res.body.map((n) => [n.id, n.status])).toEqual([
        [first.id, 'confirmed'],
        [second.id, 'reported'],
      ]);
      expect(res.body[0]).toMatchObject({ artist_name: `${PREFIX} list`, album_title: `${PREFIX} list album` });
    });

    test('a release’s list holds only the notes whose album_id is that release', async () => {
      const release = await seedLibraryRelease({ artist_name: `${PREFIX} Artist`, album_title: `${PREFIX} listed` });
      const other = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} other` });
      const mine = await seedFccNote({ album_id: release.id });
      await seedFccNote({ album_id: other.id });

      const res = await djA.get(`/fcc-notes?album_id=${release.id}`);

      expect(res.body.map((n) => n.id)).toEqual([mine.id]);
      expect(res.body[0]).toMatchObject({ artist_name: `${PREFIX} Artist`, album_title: `${PREFIX} listed` });
    });

    test.each(['', '?album_id=1&intake_item_id=1', '?album_id=0', '?intake_item_id=abc'])(
      '%s is a 400',
      async (query) => {
        expect((await djA.get(`/fcc-notes${query}`)).status).toBe(400);
      }
    );
  });

  describe('confirm, delete and the waiting list (BS#2863)', () => {
    const reportedBy = (id, extra) => seedFccNote({ reported_by_user_id: id, ...extra });

    test('a music director confirms a reported note, stamped with their account name and the time; a second confirm changes nothing', async () => {
      const item = await pooledItem('confirm');
      const reported = await reportedBy(global.primary_dj_id, { intake_item_id: item.id });
      const [{ name }] = await sql.unsafe(`SELECT name FROM auth_user WHERE username = 'test_station_manager'`);

      const first = await manager.post(`/fcc-notes/${reported.id}/confirm`);

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        id: reported.id,
        status: 'confirmed',
        confirmed_by: name,
        artist_name: `${PREFIX} confirm`,
        album_title: `${PREFIX} confirm album`,
      });
      expect(first.body.confirmed_at).not.toBeNull();
      const second = await manager.post(`/fcc-notes/${reported.id}/confirm`);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
    });

    test.each([
      ['an unknown note', '2147483647', 404],
      ['a malformed id', 'abc', 400],
      ['an id past int4', '2147483648', 400],
    ])('confirming %s is a %i', async (_name, id, status) => {
      expect((await manager.post(`/fcc-notes/${id}/confirm`)).status).toBe(status);
    });

    test('the reporter deletes their own reported note; the row is gone', async () => {
      const item = await pooledItem('own');
      const reported = await reportedBy(global.primary_dj_id, { intake_item_id: item.id });

      const res = await djA.delete(`/fcc-notes/${reported.id}`);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await noteRows('id', reported.id)).toHaveLength(0);
    });

    test('the reporter of a confirmed note, and a DJ who did not report it, are refused and the note stays', async () => {
      const item = await pooledItem('refused');
      const confirmed = await reportedBy(global.primary_dj_id, {
        intake_item_id: item.id,
        status: 'confirmed',
        confirmed_by: 'Test Reviewer',
        confirmed_at: '2026-10-03T12:00:00Z',
      });
      const someoneElses = await reportedBy(null, { intake_item_id: item.id });

      expect((await djA.delete(`/fcc-notes/${confirmed.id}`)).status).toBe(403);
      expect((await djA.delete(`/fcc-notes/${someoneElses.id}`)).status).toBe(403);

      expect(await noteRows('intake_item_id', item.id)).toHaveLength(2);
    });

    test('a music director deletes a confirmed note, and an unknown note is 404', async () => {
      const item = await pooledItem('md-delete');
      const confirmed = await reportedBy(null, {
        intake_item_id: item.id,
        status: 'confirmed',
        confirmed_by: 'Test Reviewer',
        confirmed_at: '2026-10-03T12:00:00Z',
      });

      expect((await manager.delete(`/fcc-notes/${confirmed.id}`)).status).toBe(204);
      expect(await noteRows('id', confirmed.id)).toHaveLength(0);
      expect((await manager.delete('/fcc-notes/2147483647')).status).toBe(404);
      expect((await manager.delete('/fcc-notes/abc')).status).toBe(400);
    });

    test('the waiting list holds every reported note and no confirmed one, oldest first, for a music director only', async () => {
      const item = await pooledItem('waiting');
      const release = await seedLibraryRelease({ artist_name: `${PREFIX} Artist`, album_title: `${PREFIX} waiting` });
      const newer = await seedFccNote({ album_id: release.id, reported_at: '2026-10-02T12:00:00Z' });
      const older = await seedFccNote({ intake_item_id: item.id, reported_at: '2026-10-01T12:00:00Z' });
      const done = await seedFccNote({
        intake_item_id: item.id,
        reported_at: '2026-10-01T06:00:00Z',
        status: 'confirmed',
        confirmed_by: 'Test Reviewer',
        confirmed_at: '2026-10-03T12:00:00Z',
      });

      const res = await manager.get('/fcc-notes?status=reported');

      expect(res.status).toBe(200);
      const mine = res.body.filter((n) => [newer.id, older.id, done.id].includes(n.id));
      expect(mine.map((n) => n.id)).toEqual([older.id, newer.id]);
      expect(res.body.every((n) => n.status === 'reported')).toBe(true);
      expect(mine[0]).toMatchObject({ artist_name: `${PREFIX} waiting`, intake_item_id: item.id });
      expect(mine[1]).toMatchObject({ artist_name: `${PREFIX} Artist`, album_id: release.id });
      expect((await djA.get('/fcc-notes?status=reported')).status).toBe(403);
      expect((await manager.get('/fcc-notes?status=confirmed')).status).toBe(400);
    });

    test('a record’s list sent with a status keeps only that status, for any DJ', async () => {
      const item = await pooledItem('status');
      await seedFccNote({ intake_item_id: item.id, reported_at: '2026-10-01T12:00:00Z' });
      const done = await seedFccNote({
        intake_item_id: item.id,
        reported_at: '2026-10-02T12:00:00Z',
        status: 'confirmed',
        confirmed_by: 'Test Reviewer',
        confirmed_at: '2026-10-03T12:00:00Z',
      });

      const res = await djA.get(`/fcc-notes?intake_item_id=${item.id}&status=confirmed`);

      expect(res.body.map((n) => n.id)).toEqual([done.id]);
    });
  });

  describe('filing an item stamps its notes with the release', () => {
    test('existing release: the note is on the release’s list, and keeps its item', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} existing` });
      const item = await reviewedItem('existing');
      const reported = await djA.post('/fcc-notes').send(note({ intake_item_id: item.id }));
      expect(reported.body.album_id).toBeNull();

      await fileExisting(item.id, release.id).expect(200);

      const listed = await djA.get(`/fcc-notes?album_id=${release.id}`);
      expect(listed.body.map((n) => [n.id, n.intake_item_id])).toEqual([[reported.body.id, item.id]]);
    });

    test('new release: the note is on the new release’s list', async () => {
      const item = await reviewedItem('new');
      const reported = await djA.post('/fcc-notes').send(note({ intake_item_id: item.id }));

      const filed = await fileNew(item.id);

      expect(filed.status).toBe(200);
      const listed = await djA.get(`/fcc-notes?album_id=${filed.body.album_id}`);
      expect(listed.body.map((n) => n.id)).toEqual([reported.body.id]);
    });

    test('a note reported while the item is being filed ends with its release set, whichever commits first', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} race` });
      const item = await reviewedItem('race');

      const [reported, filed] = await Promise.all([
        djA.post('/fcc-notes').send(note({ intake_item_id: item.id })),
        fileExisting(item.id, release.id),
      ]);

      expect(filed.status).toBe(200);
      expect(reported.status).toBe(200);
      expect((await noteRows('intake_item_id', item.id)).map((n) => n.album_id)).toEqual([release.id]);
    });
  });

  describe('delete and restore of the filed release', () => {
    test('brings back the note with its item and album ids', async () => {
      const item = await reviewedItem('restore');
      const reported = await djA.post('/fcc-notes').send(note({ intake_item_id: item.id }));
      const filed = await fileNew(item.id);
      expect(filed.status).toBe(200);
      const albumId = filed.body.album_id;

      await manager.delete(`/library/${albumId}`).expect(204);
      const [{ batch_id }] = await sql.unsafe(
        `SELECT batch_id FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [albumId]
      );
      await manager.post(`/library/deleted/${batch_id}/restore`).send({}).expect(200);

      const rows = await noteRows('intake_item_id', item.id);
      expect(rows.map((n) => [n.id, n.intake_item_id, n.album_id])).toEqual([[reported.body.id, item.id, albumId]]);
    });
  });
});
