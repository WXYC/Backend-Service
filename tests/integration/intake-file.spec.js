/**
 * `POST /intake/{id}/file` (BS#2803, slice 11 of BS#2791): a reviewed item becomes a library release, or is filed
 * onto one that exists, in one transaction with the item's own bookkeeping. Real Postgres, seeded through
 * tests/utils/intake_seed.js. The CI containers run AUTH_BYPASS=true, so the double grant is pinned by
 * tests/unit/routes/intake-file.route.test.ts and the existing-release lock order by
 * tests/unit/services/intake.file.service.test.ts; this tier pins the SQL against real rows and the race against a
 * concurrent review delete.
 *
 * New-release filings mint an artist (the create arm) and leave it behind, as library-filings.spec.js does: a random
 * 4-character code per call keeps reruns from colliding. The library, rotation and rotation-card rows are removed.
 */

const { randomInt } = require('node:crypto');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedAuthUser,
  removeSeededAuthUsers,
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewPrint,
  seedAcceptance,
  managerAccessToken,
  managerUserId,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-FILE';
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const uniqueSuffix = () => Array.from({ length: 4 }, () => BASE36[randomInt(BASE36.length)]).join('');
const GENRE = 11;

describe('POST /intake/:id/file (BS#2803)', () => {
  let manager;
  let managerId;
  let sql;
  const filedAlbumIds = [];
  const rotationIds = [];
  const cardIds = [];

  const now = () => new Date().toISOString();
  const itemRow = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]))[0];
  const stampsOf = async (table, id) =>
    (await sql.unsafe(`SELECT album_id FROM "${SCHEMA}".${table} WHERE intake_item_id = $1 ORDER BY id`, [id])).map(
      (row) => row.album_id
    );
  const libraryCount = async () => (await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".library`))[0].n;

  /** A `reviewed` item held by the primary DJ, with its own submitted review accepted, plus a draft and a print-log row. */
  const reviewedItem = async (key, overrides = {}) => {
    const item = await seedIntakeItem({
      artist_name: `${PREFIX} ${key}`,
      state: 'reviewed',
      checked_out_by: global.primary_dj_id,
      checked_out_at: now(),
      ...overrides,
    });
    const accepted = await seedReview({ intake_item_id: item.id, author: `${PREFIX} author` });
    await seedAcceptance({ intake_item_id: item.id, review_id: accepted.id });
    return { item, accepted };
  };
  const newRelease = (suffix, extra = {}) => ({
    kind: 'new_release',
    artist: {
      kind: 'create',
      artist_name: `${PREFIX} Artist ${suffix}`,
      code_letters: suffix,
      genre_id: GENRE,
      code_number: 1,
    },
    release: { album_title: `${PREFIX} Album ${suffix}`, label: 'Test Label', genre_id: GENRE, format_id: 1 },
    ...extra,
  });
  const file = (id, body) => manager.post(`/intake/${id}/file`).send(body);
  const fileNew = async (id, extra) => {
    const res = await file(id, newRelease(uniqueSuffix(), extra));
    if (res.status === 200) filedAlbumIds.push(res.body.album_id);
    return res;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    if (rotationIds.length > 0) await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rotationIds})`;
    if (filedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${filedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY(${filedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_delete_denylist WHERE library_id = ANY(${filedAlbumIds})`;
    }
    if (cardIds.length > 0) await sql`DELETE FROM ${sql(SCHEMA)}.rotation_cards WHERE id = ANY(${cardIds})`;
    rotationIds.length = filedAlbumIds.length = cardIds.length = 0;
    await removeSeededLibraryReleases();
    await removeSeededAuthUsers();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    managerId = await managerUserId();
    await cleanup();
  });

  afterAll(cleanup);

  describe('new release', () => {
    test('creates the library row and the rotation entry, marks the item filed and stamps every review and print', async () => {
      const { item, accepted } = await reviewedItem('new');
      await seedReview({ intake_item_id: item.id, status: 'draft', author: `${PREFIX} author` });
      await seedReviewPrint({ intake_item_id: item.id, review_id: accepted.id });
      const requester = await seedAuthUser();
      await sql.unsafe(`INSERT INTO "${SCHEMA}".intake_item_passes (intake_item_id, dj_id) VALUES ($1, $2)`, [
        item.id,
        requester.id,
      ]);
      const before = await itemRow(item.id);

      const res = await fileNew(item.id, { rotation: { rotation_bin: 'S' } });

      expect(res.status).toBe(200);
      const after = await itemRow(item.id);
      rotationIds.push(after.rotation_id);
      expect(res.body).toMatchObject({ state: 'filed', album_id: after.album_id, rotation_id: after.rotation_id });
      expect(after.album_id).not.toBeNull();
      expect(after.rotation_id).not.toBeNull();
      expect([after.filed_by, after.filed_at === null]).toEqual([managerId, false]);
      // The accept columns stay; the holder and the request fields go.
      expect([after.accepted_review_id, after.accepted_by, after.accepted_at]).toEqual([
        before.accepted_review_id,
        before.accepted_by,
        before.accepted_at,
      ]);
      expect([after.checked_out_by, after.checked_out_at, after.requested_dj_id, after.requested_at]).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(await stampsOf('reviews', item.id)).toEqual([after.album_id, after.album_id]);
      expect(await stampsOf('review_prints', item.id)).toEqual([after.album_id]);
      const passes = await sql.unsafe(`SELECT id FROM "${SCHEMA}".intake_item_passes WHERE intake_item_id = $1`, [
        item.id,
      ]);
      expect(passes).toEqual([]);
      const [library] = await sql.unsafe(`SELECT album_title FROM "${SCHEMA}".library WHERE id = $1`, [after.album_id]);
      expect(library.album_title).toContain(PREFIX);
    });

    test('a rotation failure after the library insert rolls back the release, the item and the stamps', async () => {
      const { item } = await reviewedItem('rollback');
      const card = await manager
        .post('/library/rotation/cards')
        .send({ bin: 'H', name: `${PREFIX} card` })
        .expect(200);
      cardIds.push(card.body.id);
      const before = await itemRow(item.id);
      const rows = await libraryCount();

      const res = await file(
        item.id,
        newRelease(uniqueSuffix(), { rotation: { rotation_bin: 'S', card_id: card.body.id } })
      );

      expect([res.status, res.body.reason]).toEqual([409, 'rotation_card_bin_mismatch']);
      expect(await libraryCount()).toBe(rows);
      expect(await itemRow(item.id)).toEqual(before);
      expect(await stampsOf('reviews', item.id)).toEqual([null]);
    });

    test('an artist code conflict answers the filing bench’s body and writes nothing', async () => {
      const first = await reviewedItem('first');
      const second = await reviewedItem('second');
      const suffix = uniqueSuffix();
      expect((await file(first.item.id, newRelease(suffix))).status).toBe(200);
      filedAlbumIds.push((await itemRow(first.item.id)).album_id);
      const before = await itemRow(second.item.id);

      const res = await file(second.item.id, newRelease(suffix));

      expect([res.status, res.body.reason]).toEqual([409, 'artist_code_conflict']);
      expect(await itemRow(second.item.id)).toEqual(before);
    });
  });

  describe('existing release', () => {
    test('stamps without inserting a library row, and clears the holder', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} existing` });
      const { item, accepted } = await reviewedItem('existing');
      const rows = await libraryCount();

      const res = await file(item.id, { kind: 'existing_release', album_id: release.id });

      expect(res.status).toBe(200);
      expect(await libraryCount()).toBe(rows);
      const after = await itemRow(item.id);
      expect([after.state, after.album_id, after.rotation_id, after.checked_out_by]).toEqual([
        'filed',
        release.id,
        null,
        null,
      ]);
      expect(after.accepted_review_id).toBe(accepted.id);
      expect(await stampsOf('reviews', item.id)).toEqual([release.id]);
    });

    test('an album that names no library release is a 400 and writes nothing', async () => {
      const { item } = await reviewedItem('dangling');
      const before = await itemRow(item.id);
      expect((await file(item.id, { kind: 'existing_release', album_id: 2147483647 })).status).toBe(400);
      expect(await itemRow(item.id)).toEqual(before);
    });
  });

  describe('the precondition', () => {
    test.each([
      ['uncited', false],
      ['cited', true],
    ])('an %s item with submitted reviews and no accepted one is not_reviewed', async (_name, cited) => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} cited` });
      const item = await seedIntakeItem({
        artist_name: `${PREFIX} unreviewed`,
        state: 'checked_out',
        checked_out_by: global.primary_dj_id,
        checked_out_at: now(),
        ...(cited && { cited_album_id: release.id }),
      });
      await seedReview({ intake_item_id: item.id, author: `${PREFIX} author` });
      await seedReview({ album_id: release.id, author: `${PREFIX} author` });
      const res = await file(item.id, { kind: 'existing_release', album_id: release.id });
      expect([res.status, res.body.reason]).toEqual([409, 'not_reviewed']);
      expect((await itemRow(item.id)).state).toBe('checked_out');
    });

    test('a cited item files once a typed review of the cited release is accepted for it, and its holder is cleared', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} cover` });
      const copy = await seedIntakeItem({
        artist_name: `${PREFIX} copy`,
        state: 'checked_out',
        checked_out_by: global.primary_dj_id,
        checked_out_at: now(),
        cited_album_id: release.id,
      });
      const cover = await seedReview({ album_id: release.id, author: `${PREFIX} author` });
      await manager.post(`/intake/${copy.id}/accept-review`).send({ review_id: cover.id }).expect(200);

      const res = await file(copy.id, { kind: 'existing_release', album_id: release.id });

      expect(res.status).toBe(200);
      const after = await itemRow(copy.id);
      expect([after.state, after.accepted_review_id, after.checked_out_by, after.checked_out_at]).toEqual([
        'filed',
        cover.id,
        null,
        null,
      ]);
    });

    test('an item that is already filed is state_changed, and an unknown item is a 404', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} twice` });
      const { item } = await reviewedItem('twice');
      expect((await file(item.id, { kind: 'existing_release', album_id: release.id })).status).toBe(200);
      const again = await file(item.id, { kind: 'existing_release', album_id: release.id });
      expect([again.status, again.body.reason]).toEqual([409, 'state_changed']);
      expect((await file(2147483647, { kind: 'existing_release', album_id: release.id })).status).toBe(404);
    });
  });

  describe('against a concurrent delete of the accepted review', () => {
    test('ends filed with the review kept, or unfiled with the review gone, never filed without an accepted review', async () => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} race` });
      const { item, accepted } = await reviewedItem('race');

      const [fileRes, deleteRes] = await Promise.all([
        file(item.id, { kind: 'existing_release', album_id: release.id }),
        manager.delete(`/reviews/${accepted.id}`),
      ]);

      const after = await itemRow(item.id);
      if (fileRes.status === 200) {
        expect(deleteRes.status).toBe(409);
        expect(deleteRes.body.reason).toBe('accepted_review');
        expect([after.state, after.accepted_review_id]).toEqual(['filed', accepted.id]);
      } else {
        expect([fileRes.status, fileRes.body.reason]).toEqual([409, 'not_reviewed']);
        expect(deleteRes.status).toBe(204);
        expect(after.state).toBe('checked_out');
        expect(after.accepted_review_id).toBeNull();
      }
    });
  });

  describe('delete and restore of the filed release', () => {
    test('brings back both reviews and the print with their item and album ids, the item pointing at the restored review', async () => {
      const { item, accepted } = await reviewedItem('restore');
      const draft = await seedReview({ intake_item_id: item.id, status: 'draft', author: `${PREFIX} author` });
      const print = await seedReviewPrint({ intake_item_id: item.id, review_id: accepted.id });
      const res = await fileNew(item.id);
      expect(res.status).toBe(200);
      const albumId = res.body.album_id;

      await manager.delete(`/library/${albumId}`).expect(204);
      const [{ batch_id }] = await sql.unsafe(
        `SELECT batch_id FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [albumId]
      );
      await manager.post(`/library/deleted/${batch_id}/restore`).send({}).expect(200);

      const reviews = await sql.unsafe(
        `SELECT id, intake_item_id, album_id FROM "${SCHEMA}".reviews WHERE album_id = $1 ORDER BY id`,
        [albumId]
      );
      expect(reviews).toEqual([
        { id: accepted.id, intake_item_id: item.id, album_id: albumId },
        { id: draft.id, intake_item_id: item.id, album_id: albumId },
      ]);
      const prints = await sql.unsafe(`SELECT id, album_id FROM "${SCHEMA}".review_prints WHERE intake_item_id = $1`, [
        item.id,
      ]);
      expect(prints).toEqual([{ id: print.id, album_id: albumId }]);
      expect((await itemRow(item.id)).accepted_review_id).toBe(accepted.id);
    });
  });
});
