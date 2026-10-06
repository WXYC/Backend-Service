/**
 * `GET /reviews/{id}/revisions` and `Review.revision_count` (BS#2861, slice 13b of BS#2791). Real Postgres, seeded
 * through tests/utils/intake_seed.js. As in reviews.spec.js the CI containers run AUTH_BYPASS=true, so the route
 * grant is pinned by tests/unit/routes/reviews-permissions.route.test.ts; this tier pins what the SQL returns:
 * the history in order with the right `edited_by` on each version, draft privacy, and the count on every shape.
 * `djA` is a raw user-id Bearer (a non-manager acting as that id).
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
  managerAccessToken,
  managerUserId,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-REVISIONS';

describe('/reviews revision history (BS#2861)', () => {
  let manager;
  let djA;
  let djB;
  let sql;
  let libraryId;

  const userName = async (id) => (await sql.unsafe(`SELECT name FROM auth_user WHERE id = $1`, [id]))[0].name;
  const draftFor = (overrides = {}) =>
    seedReview({
      album_id: libraryId,
      author: `${PREFIX} author`,
      author_user_id: global.primary_dj_id,
      status: 'draft',
      submitted_at: null,
      ...overrides,
    });
  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    await cleanup();
    libraryId = (await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` })).id;
  });

  afterAll(cleanup);

  test('submit, an author edit and a music director edit read back as three versions, newest first', async () => {
    const held = await seedIntakeItem({
      artist_name: `${PREFIX} held`,
      state: 'checked_out',
      checked_out_by: global.primary_dj_id,
      checked_out_at: new Date().toISOString(),
    });
    const draft = await djA.post('/reviews').send({ intake_item_id: held.id, review: 'First take.' });
    expect([draft.status, draft.body.revision_count]).toEqual([200, 0]);
    await sql.unsafe(`UPDATE "${SCHEMA}".reviews SET author = $1 WHERE id = $2`, [`${PREFIX} author`, draft.body.id]);
    const id = draft.body.id;

    const submitted = await djA.post(`/reviews/${id}/submit`);
    expect(submitted.body.revision_count).toBe(1);
    const byAuthor = await djA.patch(`/reviews/${id}`).send({ review: 'Second take.' });
    expect(byAuthor.body.revision_count).toBe(2);
    const byManager = await manager.patch(`/reviews/${id}`).send({ review: 'Third take.' });
    expect(byManager.body.revision_count).toBe(3);

    const res = await manager.get(`/reviews/${id}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => [r.revision, r.review, r.edited_by])).toEqual([
      [3, 'Third take.', await userName(await managerUserId())],
      [2, 'Second take.', await userName(global.primary_dj_id)],
      [1, 'First take.', `${PREFIX} author`],
    ]);
    expect(Object.keys(res.body[0]).sort()).toEqual(
      [
        'artist_blurb',
        'buzzwords',
        'edited_at',
        'edited_by',
        'edited_by_user_id',
        'fcc',
        'id',
        'recommended_tracks',
        'review',
        'review_id',
        'revision',
      ].sort()
    );
    expect((await djA.get(`/reviews/${id}`)).body.revision_count).toBe(3);
  });

  test('revision_count rides on every list shape', async () => {
    const review = await seedReview({
      album_id: libraryId,
      author: `${PREFIX} listed`,
      author_user_id: global.primary_dj_id,
    });
    await djA.patch(`/reviews/${review.id}`).send({ review: 'Edited once.' });
    const counts = async (query) =>
      (await djA.get('/reviews').query(query)).body.filter((r) => r.id === review.id).map((r) => r.revision_count);
    expect(await counts({})).toEqual([2]);
    expect(await counts({ album_id: libraryId })).toEqual([2]);
    expect(await counts({ mine: true })).toEqual([2]);
  });

  test('a submitted review with no history counts 0, and 2 after its first edit', async () => {
    const review = await seedReview({
      album_id: libraryId,
      author: `${PREFIX} legacy`,
      author_user_id: global.primary_dj_id,
    });
    expect((await djA.get(`/reviews/${review.id}`)).body.revision_count).toBe(0);
    expect((await djA.get(`/reviews/${review.id}/revisions`)).body).toEqual([]);
    expect((await djA.patch(`/reviews/${review.id}`).send({ review: 'Now edited.' })).body.revision_count).toBe(2);
    expect((await djA.get(`/reviews/${review.id}/revisions`)).body.map((r) => r.revision)).toEqual([2, 1]);
  });

  test("another DJ's draft is a 404 for a DJ and a music director; the author's own draft is []", async () => {
    const draft = await draftFor();
    expect((await djB.get(`/reviews/${draft.id}/revisions`)).status).toBe(404);
    expect((await manager.get(`/reviews/${draft.id}/revisions`)).status).toBe(404);
    const own = await djA.get(`/reviews/${draft.id}/revisions`);
    expect([own.status, own.body]).toEqual([200, []]);
  });

  test('an unknown id is a 404 and a malformed one a 400', async () => {
    expect((await djA.get('/reviews/2147483647/revisions')).status).toBe(404);
    expect((await djA.get('/reviews/abc/revisions')).status).toBe(400);
  });
});
