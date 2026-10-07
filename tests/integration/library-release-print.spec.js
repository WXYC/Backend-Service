/**
 * `POST /library/{id}/print` (BS#2865, slice 12b of BS#2791). Real Postgres, seeded through tests/utils/intake_seed.js.
 * The CI containers run AUTH_BYPASS=true, so the route grant is pinned by tests/unit/routes/library-print.route.test.ts.
 * This tier pins what real rows add: the print-log row with no intake item, the refusals, the review leading
 * `GET /reviews?album_id=` as `on_cover` and `in_use`, and the print-log row coming back when a deleted release is restored.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-RELEASE-PRINT';

describe('POST /library/{id}/print (BS#2865)', () => {
  let manager;
  let djA;
  let sql;

  const release = async (key) =>
    (await seedLibraryRelease({ artist_name: `${PREFIX} ${key}`, album_title: `${PREFIX} ${key} album` })).id;
  const typedReview = (albumId, overrides = {}) =>
    seedReview({
      album_id: albumId,
      author: `${PREFIX} author`,
      author_user_id: global.primary_dj_id,
      review: 'First text.',
      ...overrides,
    });
  const printsOf = (albumId) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".review_prints WHERE album_id = $1 ORDER BY id`, [albumId]);
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
  });

  afterAll(cleanup);

  test('prints a typed submitted review: revision 1 is written, one row is logged with no intake item, and the slip names the release', async () => {
    const albumId = await release('first');
    const review = await typedReview(albumId);
    const res = await manager.post(`/library/${albumId}/print`).send({ review_id: review.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      artist_name: `${PREFIX} first`,
      album_title: `${PREFIX} first album`,
      review: 'First text.',
      author: `${PREFIX} author`,
      fcc_notes: [],
    });
    const prints = await printsOf(albumId);
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ review_id: review.id, revision_id: res.body.revision_id, intake_item_id: null });
  });

  test('a reprint appends another row; the review leads the release list on the cover and its author cannot delete it', async () => {
    const albumId = await release('reprint');
    await typedReview(albumId, { review: 'Older review.', submitted_at: '2020-01-01T00:00:00Z' });
    const printed = await typedReview(albumId, { review: 'Printed review.', submitted_at: '2019-01-01T00:00:00Z' });
    await manager.post(`/library/${albumId}/print`).send({ review_id: printed.id }).expect(200);
    await manager.post(`/library/${albumId}/print`).send({ review_id: printed.id }).expect(200);
    expect(await printsOf(albumId)).toHaveLength(2);

    const list = await manager.get(`/reviews?album_id=${albumId}`).expect(200);
    expect(list.body[0]).toMatchObject({ id: printed.id, on_cover: true, in_use: true });
    expect(list.body[1]).toMatchObject({ on_cover: false });
    const refused = await djA.delete(`/reviews/${printed.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('in_use');
  });

  test.each([
    ['a draft', (albumId) => typedReview(albumId, { status: 'draft' })],
    ['a handwritten review', (albumId) => typedReview(albumId, { medium: 'handwritten' })],
    ['a review of another release', async () => typedReview(await release('other'))],
  ])('%s is a 400 and writes nothing', async (_name, make) => {
    const albumId = await release('refused');
    const review = await make(albumId);
    const res = await manager.post(`/library/${albumId}/print`).send({ review_id: review.id });
    expect(res.status).toBe(400);
    expect(await printsOf(albumId)).toHaveLength(0);
  });

  test('an unknown review is a 400, an unknown release a 404, and a missing review_id a 400', async () => {
    const albumId = await release('unknown');
    await manager.post(`/library/${albumId}/print`).send({ review_id: 2147483647 }).expect(400);
    await manager.post(`/library/${albumId}/print`).send({}).expect(400);
    const review = await typedReview(albumId);
    await manager.post('/library/2147483647/print').send({ review_id: review.id }).expect(404);
  });

  test('deleting the release and restoring its batch brings the print-log row back', async () => {
    const albumId = await release('restore');
    const review = await typedReview(albumId);
    await manager.post(`/library/${albumId}/print`).send({ review_id: review.id }).expect(200);
    await manager.delete(`/library/${albumId}`).expect(204);
    expect(await printsOf(albumId)).toHaveLength(0);
    const [{ batch_id: batchId }] = await sql.unsafe(
      `SELECT batch_id FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [albumId]
    );
    await manager.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);
    const prints = await printsOf(albumId);
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ review_id: review.id, intake_item_id: null });
  });
});
