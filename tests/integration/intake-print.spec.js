/**
 * `POST /intake/{id}/print` and `POST /intake/{id}/finalize` (BS#2804, slice 12 of BS#2791). Real Postgres, seeded
 * through tests/utils/intake_seed.js. As in intake-accept-review.spec.js the CI containers run AUTH_BYPASS=true, so the
 * route grants are pinned by tests/unit/routes/intake-print-finalize.route.test.ts and `djA` is a raw user-id Bearer
 * acting as the review's author. What this tier pins is the print log and the slip against real rows, the serialization of
 * a print and an edit of one review (for an item's own review it is the intake item lock, print FOR UPDATE and PATCH
 * FOR SHARE, that orders them; the review lock matters only for a cited item, which is pinned in the unit lock log):
 * whichever commits second, the logged revision is one that existed when the print committed, and the slip's text is
 * that revision's, the confirmed FCC notes on the slip (BS#2863). And finalize's refusal while the release is in rotation, against real `rotation` rows.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
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
const PREFIX = 'ITEST-PRINT';

describe('/intake print and finalize (BS#2804)', () => {
  let manager;
  let djA;
  let sql;
  let releaseId;

  const reviewedItem = async (key, reviewOverrides = {}) => {
    const item = await seedIntakeItem({ artist_name: `${PREFIX} ${key}`, state: 'reviewed' });
    const review = await seedReview({
      intake_item_id: item.id,
      author: `${PREFIX} author`,
      author_user_id: global.primary_dj_id,
      review: 'First text.',
      ...reviewOverrides,
    });
    await seedAcceptance({ intake_item_id: item.id, review_id: review.id });
    return { item, review };
  };
  const printsOf = (itemId) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".review_prints WHERE intake_item_id = $1 ORDER BY id`, [itemId]);
  const revisionsOf = (reviewId) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".review_revisions WHERE review_id = $1 ORDER BY revision`, [reviewId]);
  const itemRow = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]))[0];
  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    sql = getTestDb();
    await cleanup();
    releaseId = (await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` })).id;
  });

  afterAll(cleanup);

  describe('print', () => {
    test('an unfiled reviewed item prints: revision 1 is written for the review with no history, logged and on the slip', async () => {
      const { item, review } = await reviewedItem('first');
      const res = await manager.post(`/intake/${item.id}/print`);
      expect(res.status).toBe(200);
      const [revision] = await revisionsOf(review.id);
      expect(revision).toMatchObject({ revision: 1, review: 'First text.' });
      expect(res.body).toMatchObject({
        artist_name: `${PREFIX} first`,
        review: 'First text.',
        author: `${PREFIX} author`,
        revision_id: revision.id,
        fcc_notes: [],
      });
      const [print] = await printsOf(item.id);
      expect(print).toMatchObject({ review_id: review.id, revision_id: revision.id, album_id: null });
      const row = await itemRow(item.id);
      expect(row.printed_by).not.toBeNull();
      expect(row.printed_at).not.toBeNull();
    });

    test('a reprint after an edit appends a second row naming the newer revision, and the slip carries the new text', async () => {
      const { item, review } = await reviewedItem('reprint');
      await manager.post(`/intake/${item.id}/print`);
      expect((await djA.patch(`/reviews/${review.id}`).send({ review: 'Second text.' })).status).toBe(200);
      const res = await manager.post(`/intake/${item.id}/print`);
      expect([res.status, res.body.review]).toEqual([200, 'Second text.']);
      const prints = await printsOf(item.id);
      const revisions = await revisionsOf(review.id);
      expect(prints.map((p) => p.revision_id)).toEqual(revisions.map((r) => r.id));
    });

    test('a filed item prints with the release stamped on the log row', async () => {
      const { item } = await reviewedItem('filed');
      await sql.unsafe(`UPDATE "${SCHEMA}".intake_items SET state = 'filed', album_id = $1 WHERE id = $2`, [
        releaseId,
        item.id,
      ]);
      expect((await manager.post(`/intake/${item.id}/print`)).status).toBe(200);
      expect((await printsOf(item.id))[0].album_id).toBe(releaseId);
    });

    test('the slip carries the confirmed FCC notes of the item and of its release, oldest first, and no reported note', async () => {
      const { item } = await reviewedItem('notes');
      const other = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} other release` });
      await sql.unsafe(`UPDATE "${SCHEMA}".intake_items SET state = 'filed', album_id = $1 WHERE id = $2`, [
        releaseId,
        item.id,
      ]);
      const confirmed = { status: 'confirmed', confirmed_by: 'Test Confirmer', confirmed_at: '2026-10-04T12:00:00Z' };
      await seedFccNote({
        album_id: releaseId,
        track: 'B2',
        note: 'On the release.',
        reported_at: '2026-10-02T12:00:00Z',
        ...confirmed,
      });
      await seedFccNote({
        intake_item_id: item.id,
        track: 'A1',
        note: 'On the item.',
        reported_at: '2026-10-01T12:00:00Z',
        ...confirmed,
      });
      await seedFccNote({
        intake_item_id: item.id,
        track: 'C3',
        note: 'Still reported.',
        reported_at: '2026-10-03T12:00:00Z',
      });
      await seedFccNote({
        album_id: other.id,
        track: 'D4',
        note: 'On another release.',
        reported_at: '2026-10-01T12:00:00Z',
        ...confirmed,
      });

      const res = await manager.post(`/intake/${item.id}/print`);

      expect(res.status).toBe(200);
      expect(res.body.fcc_notes).toEqual([
        { track: 'A1', note: 'On the item.' },
        { track: 'B2', note: 'On the release.' },
      ]);
    });

    test('no accepted review, a handwritten one and a missing item are 409, 409 and 404', async () => {
      const bare = await seedIntakeItem({ artist_name: `${PREFIX} bare`, state: 'reviewed' });
      const { item: handwritten } = await reviewedItem('handwritten', { medium: 'handwritten', review: null });
      for (const id of [bare.id, handwritten.id]) {
        const res = await manager.post(`/intake/${id}/print`);
        expect([res.status, res.body.reason]).toEqual([409, 'not_reviewed']);
        expect(await printsOf(id)).toEqual([]);
      }
      expect((await manager.post('/intake/2147483647/print')).status).toBe(404);
    });

    // The item lock serializes these two requests: print takes the intake item FOR UPDATE and PATCH takes it FOR SHARE.
    // (The review's own FOR UPDATE is not what orders them here.)
    test('a print and a concurrent edit of one review leave a log row naming a revision that existed, with that text on the slip', async () => {
      for (let round = 0; round < 5; round += 1) {
        const { item, review } = await reviewedItem(`race ${round}`);
        const [printed, edited] = await Promise.all([
          manager.post(`/intake/${item.id}/print`),
          djA.patch(`/reviews/${review.id}`).send({ review: `Edited text ${round}.` }),
        ]);
        expect([printed.status, edited.status]).toEqual([200, 200]);
        const revisions = await revisionsOf(review.id);
        const [print] = await printsOf(item.id);
        const logged = revisions.find((r) => r.id === print.revision_id);
        expect(logged).toBeDefined();
        expect(printed.body.revision_id).toBe(logged.id);
        expect(printed.body.review).toBe(logged.review);
        expect(['First text.', `Edited text ${round}.`]).toContain(logged.review);
      }
    });
  });

  describe('finalize', () => {
    const filedItem = (key) => seedIntakeItem({ artist_name: `${PREFIX} ${key}`, state: 'filed', album_id: releaseId });

    test('a filed item with no active rotation row is finalized and stamped', async () => {
      const item = await filedItem('finalize');
      const res = await manager.post(`/intake/${item.id}/finalize`);
      expect([res.status, res.body.state]).toEqual([200, 'finalized']);
      const row = await itemRow(item.id);
      expect(row.finalized_by).not.toBeNull();
      expect(row.finalized_at).not.toBeNull();
    });

    // The finalize guard looks the release up by `rotation.album_id`, not by the item's `rotation_id`, which stays null.
    const rotatedItem = async (key) => {
      const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} ${key}` });
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin, add_date) VALUES ($1, 'H', CURRENT_DATE)`,
        [release.id]
      );
      const item = await seedIntakeItem({ artist_name: `${PREFIX} ${key}`, state: 'filed', album_id: release.id });
      expect(item.rotation_id).toBeNull();
      return { item, release };
    };
    const setKillDate = (albumId, offset) =>
      sql.unsafe(`UPDATE "${SCHEMA}".rotation SET kill_date = CURRENT_DATE + $1::int WHERE album_id = $2`, [
        offset,
        albumId,
      ]);
    const dateText = async (offset) => (await sql.unsafe(`SELECT (CURRENT_DATE + $1::int)::text AS d`, [offset]))[0].d;

    test('a filed item with a null rotation_id is 409 in_rotation while its release has an active rotation row, naming the kill date', async () => {
      const { item, release } = await rotatedItem('in rotation');
      let res = await manager.post(`/intake/${item.id}/finalize`);
      expect([res.status, res.body.reason]).toEqual([409, 'in_rotation']);
      expect(res.body.message).toContain('no kill date is set');
      await setKillDate(release.id, 30);
      res = await manager.post(`/intake/${item.id}/finalize`);
      expect([res.status, res.body.reason]).toEqual([409, 'in_rotation']);
      expect(res.body.message).toContain(`until ${await dateText(30)}`);
      expect((await itemRow(item.id)).state).toBe('filed');
    });

    test('the same item is finalized once its rotation row’s kill date has passed', async () => {
      const { item, release } = await rotatedItem('killed');
      expect((await manager.post(`/intake/${item.id}/finalize`)).status).toBe(409);
      await setKillDate(release.id, -1);
      const res = await manager.post(`/intake/${item.id}/finalize`);
      expect([res.status, res.body.state]).toEqual([200, 'finalized']);
      expect((await itemRow(item.id)).finalized_at).not.toBeNull();
    });

    test('an item that is not filed is 409 state_changed, and a second finalize too', async () => {
      const reviewed = await seedIntakeItem({ artist_name: `${PREFIX} not filed`, state: 'reviewed' });
      const res = await manager.post(`/intake/${reviewed.id}/finalize`);
      expect([res.status, res.body.reason]).toEqual([409, 'state_changed']);
      const item = await filedItem('twice');
      await manager.post(`/intake/${item.id}/finalize`);
      expect((await manager.post(`/intake/${item.id}/finalize`)).body.reason).toBe('state_changed');
      expect((await manager.post('/intake/2147483647/finalize')).status).toBe(404);
    });
  });
});
