/**
 * `POST /reviews` and `PATCH /reviews/{id}` (BS#2802, slice 10a of BS#2791). Real Postgres,
 * direct SQL seeds. As in intake-transitions.spec.js, the CI containers run AUTH_BYPASS=true, so
 * the route grants are pinned by tests/unit/routes/reviews-permissions.route.test.ts; what this
 * tier pins is the SQL: the hold check, the author snapshot, the revision history and the draft
 * privacy of the response. `djA` is a raw user-id Bearer (a non-manager acting as that id).
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-REVIEWS';

describe('/reviews create and edit (BS#2802)', () => {
  let manager;
  let managerId;
  let djA;
  let djB;
  let sql;
  let libraryId;

  const heldItem = async (key, by = global.primary_dj_id) =>
    (
      await seedIntakeItem({
        artist_name: `${PREFIX} ${key}`,
        state: 'checked_out',
        checked_out_by: by,
        checked_out_at: new Date().toISOString(),
      })
    ).id;
  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author_user_id = ANY($1)`, [
      [global.primary_dj_id, global.secondary_dj_id],
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await removeSeededLibraryReleases();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    const [managerRow] = await sql`SELECT id FROM auth_user WHERE username = 'test_station_manager'`;
    if (!managerRow) throw new Error('test_station_manager fixture account is missing');
    managerId = managerRow.id;
    await cleanup();
    libraryId = (await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` })).id;
  });

  afterAll(cleanup);

  test('a DJ creates a draft on an item they hold: 200, typed, authored by them', async () => {
    const itemId = await heldItem('held');
    const res = await djA.post('/reviews').send({ intake_item_id: itemId, review: 'Lovely.', credit: 'dj_name' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intake_item_id: itemId,
      album_id: null,
      status: 'draft',
      medium: 'typed',
      author_user_id: global.primary_dj_id,
      review: 'Lovely.',
      credit: 'dj_name',
    });
    expect(res.body).not.toHaveProperty('locked');
    expect([...res.body.author].length).toBeLessThanOrEqual(128);
  });

  test('a DJ cannot create a review on an item someone else holds, a pooled item, or a missing one', async () => {
    const theirs = await heldItem('theirs', global.secondary_dj_id);
    const pooled = (await seedIntakeItem({ artist_name: `${PREFIX} pool` })).id;
    for (const intake_item_id of [theirs, pooled, 2147483647]) {
      const res = await djA.post('/reviews').send({ intake_item_id });
      expect([res.status, res.body.reason]).toEqual([409, 'subject_not_held']);
    }
  });

  test('any DJ may review a library release; a missing release is 409', async () => {
    expect((await djA.post('/reviews').send({ album_id: libraryId })).status).toBe(200);
    expect((await djA.post('/reviews').send({ album_id: 2147483647 })).body.reason).toBe('subject_not_held');
  });

  test("another DJ's draft is a 404 to everyone else, a music director included", async () => {
    const { body } = await djA.post('/reviews').send({ album_id: libraryId });
    expect((await djB.patch(`/reviews/${body.id}`).send({ fcc: 'x' })).status).toBe(404);
    expect((await manager.patch(`/reviews/${body.id}`).send({ fcc: 'x' })).status).toBe(404);
  });

  describe('after submit (seeded directly; submit is BS#2854)', () => {
    const submit = (id) =>
      sql.unsafe(`UPDATE "${SCHEMA}".reviews SET status = 'submitted', submitted_at = now() WHERE id = $1`, [id]);

    const revisions = (id) =>
      sql.unsafe(
        `SELECT revision, review, edited_by, edited_by_user_id, edited_at FROM "${SCHEMA}".review_revisions WHERE review_id = $1 ORDER BY revision`,
        [id]
      );

    test('the author edits a review on a printed item; a music director edits it too; another DJ may not', async () => {
      const itemId = await heldItem('print');
      await sql.unsafe(`UPDATE "${SCHEMA}".intake_items SET printed_at = now() WHERE id = $1`, [itemId]);
      const seeded = await seedReview({
        intake_item_id: itemId,
        author_user_id: global.primary_dj_id,
        review: 'First.',
      });
      const own = await djA.patch(`/reviews/${seeded.id}`).send({ review: 'Second.' });
      expect([own.status, own.body.review]).toEqual([200, 'Second.']);
      expect(own.body).not.toHaveProperty('locked');
      expect((await djB.patch(`/reviews/${seeded.id}`).send({ review: 'Nope.' })).status).toBe(403);
      const md = await manager.patch(`/reviews/${seeded.id}`).send({ review: 'MD fix.' });
      expect([md.status, md.body.review]).toEqual([200, 'MD fix.']);
      const history = await revisions(seeded.id);
      // Revision 1 is the author's pre-edit text at submitted_at; 2 is the author's edit; 3 is
      // the manager's, under the manager's own id, not the author's.
      expect(history.map((r) => [r.revision, r.review, r.edited_by_user_id])).toEqual([
        [1, 'First.', global.primary_dj_id],
        [2, 'Second.', global.primary_dj_id],
        [3, 'MD fix.', managerId],
      ]);
      expect(history.map((r) => r.edited_by)).toEqual([seeded.author, expect.any(String), expect.any(String)]);
      expect(new Date(history[0].edited_at).toISOString()).toBe(new Date(seeded.submitted_at).toISOString());
    });

    test('a draft edit and a consent-only edit write no revision; a content edit of a submitted review writes one', async () => {
      const draft = await seedReview({ album_id: libraryId, author_user_id: global.primary_dj_id, status: 'draft' });
      const draftEdit = await djA.patch(`/reviews/${draft.id}`).send({ fcc: 'draft edit' });
      expect([draftEdit.status, draftEdit.body.fcc]).toEqual([200, 'draft edit']);
      const submitted = await seedReview({ album_id: libraryId, author_user_id: global.primary_dj_id });
      const consent = await djA.patch(`/reviews/${submitted.id}`).send({ credit: 'dj_name', publish_apps: true });
      expect([consent.status, consent.body.credit, consent.body.publish_apps]).toEqual([200, 'dj_name', true]);
      expect(await revisions(draft.id)).toEqual([]);
      expect(await revisions(submitted.id)).toEqual([]);
      expect((await djA.patch(`/reviews/${submitted.id}`).send({ review: 'Edited.' })).status).toBe(200);
      expect((await revisions(submitted.id)).map((r) => [r.revision, r.review, r.edited_by_user_id])).toEqual([
        [1, submitted.review, global.primary_dj_id],
        [2, 'Edited.', global.primary_dj_id],
      ]);
    });

    test("only the author's account sets consent: a music director's credit patch is 403 with its own message and nothing changes", async () => {
      const mine = await seedReview({ album_id: libraryId, author_user_id: global.primary_dj_id });
      const res = await manager.patch(`/reviews/${mine.id}`).send({ credit: 'real_name' });
      expect([res.status, res.body.message]).toEqual([403, "Only the review's author may set its publishing choices"]);
      const [row] = await sql.unsafe(`SELECT credit FROM "${SCHEMA}".reviews WHERE id = $1`, [mine.id]);
      expect(row.credit).toBeNull();
      expect(await revisions(mine.id)).toEqual([]);
      expect((await manager.patch(`/reviews/${mine.id}`).send({ buzzwords: 'warm' })).status).toBe(200);
    });

    test('two concurrent edits of one submitted review take revisions n+1 and n+2, never a duplicate', async () => {
      const seeded = await seedReview({ album_id: libraryId, author_user_id: global.primary_dj_id, review: 'Base.' });
      await djA.patch(`/reviews/${seeded.id}`).send({ review: 'One.' });
      const before = (await revisions(seeded.id)).length;
      const results = await Promise.all([
        djA.patch(`/reviews/${seeded.id}`).send({ review: 'Concurrent A.' }),
        manager.patch(`/reviews/${seeded.id}`).send({ review: 'Concurrent B.' }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const numbers = (await revisions(seeded.id)).map((r) => r.revision);
      expect(numbers).toEqual(Array.from({ length: before + 2 }, (_, i) => i + 1));
    });

    test('the author edits their own library-release review after submit; nulling a typed review text is 400', async () => {
      const { body } = await djA.post('/reviews').send({ album_id: libraryId, review: 'Fine.' });
      await submit(body.id);
      expect((await djA.patch(`/reviews/${body.id}`).send({ buzzwords: 'warm' })).body.buzzwords).toBe('warm');
      expect((await djA.patch(`/reviews/${body.id}`).send({ review: '  ' })).status).toBe(400);
    });
  });
});
