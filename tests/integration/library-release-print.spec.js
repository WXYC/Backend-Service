/**
 * `POST /library/{id}/print` (BS#2865, slice 12b of BS#2791). Real Postgres, seeded through tests/utils/intake_seed.js.
 * The CI containers run AUTH_BYPASS=true, so the route grant is pinned by tests/unit/routes/library-print.route.test.ts.
 * This tier pins what real rows add: the print-log row with no intake item, the refusals, the review leading
 * `GET /reviews?album_id=` as `on_cover` and `in_use`, a review reached only through a citation, the slip's artist for a
 * compilation filed under a Various Artists bucket, the print-log row coming back when a deleted release is restored, and a
 * release with one logged copy (BS#3075), whose print is the copy's.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  removeSeededIntakeItems,
  seedAcceptance,
  seedIntakeItem,
  seedLibraryRelease,
  seedReviewPrint,
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
  const itemRow = async (id) =>
    (
      await sql.unsafe(
        `SELECT accepted_review_id, printed_by, printed_at FROM "${SCHEMA}".intake_items WHERE id = $1`,
        [id]
      )
    )[0];
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

  test('a review reached only through a citation prints for the release’s one logged copy, which cites the release the review is on', async () => {
    const albumId = await release('citing');
    const citedId = await release('cited');
    const item = await seedIntakeItem({
      artist_name: `${PREFIX} citing`,
      album_title: `${PREFIX} citing album`,
      state: 'filed',
      album_id: albumId,
      cited_album_id: citedId,
    });
    const review = await typedReview(citedId, { review: 'Cited text.' });
    const res = await manager.post(`/library/${albumId}/print`).send({ review_id: review.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      artist_name: `${PREFIX} citing`,
      album_title: `${PREFIX} citing album`,
      review: 'Cited text.',
      author: `${PREFIX} author`,
    });
    const prints = await printsOf(albumId);
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({
      review_id: review.id,
      revision_id: res.body.revision_id,
      intake_item_id: item.id,
    });
    expect(await itemRow(item.id)).toMatchObject({ accepted_review_id: review.id });
    const list = await manager.get(`/reviews?album_id=${albumId}`).expect(200);
    expect(list.body[0]).toMatchObject({ id: review.id, on_cover: true });
  });

  test('a release with one logged copy: the printed review replaces the copy’s review on the cover, and the copy is stamped printed', async () => {
    const albumId = await release('one-copy');
    const item = await seedIntakeItem({ state: 'filed', album_id: albumId });
    const before = await typedReview(albumId, { review: 'Review on the cover.' });
    await seedAcceptance({ intake_item_id: item.id, review_id: before.id });
    const printed = await typedReview(albumId, { review: 'Fresh review.' });
    await manager.post(`/library/${albumId}/print`).send({ review_id: printed.id }).expect(200);

    const prints = await printsOf(albumId);
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ review_id: printed.id, intake_item_id: item.id });
    const stamped = await itemRow(item.id);
    expect(stamped.accepted_review_id).toBe(printed.id);
    expect(stamped.printed_by).not.toBeNull();
    expect(stamped.printed_at).not.toBeNull();
    const list = await manager.get(`/reviews?album_id=${albumId}`).expect(200);
    expect(list.body.filter((r) => r.on_cover).map((r) => r.id)).toEqual([printed.id]);
  });

  test('a release with two logged copies keeps the print with no item and writes nothing on either copy', async () => {
    const albumId = await release('two-copies');
    const first = await seedIntakeItem({ state: 'filed', album_id: albumId });
    const second = await seedIntakeItem({ state: 'finalized', album_id: albumId });
    const review = await typedReview(albumId);
    await manager.post(`/library/${albumId}/print`).send({ review_id: review.id }).expect(200);
    expect((await printsOf(albumId))[0]).toMatchObject({ review_id: review.id, intake_item_id: null });
    for (const copy of [first, second]) {
      expect(await itemRow(copy.id)).toMatchObject({ accepted_review_id: null, printed_by: null, printed_at: null });
    }
  });

  // BS#3075, decided by the station 2026-10-09: a release with exactly one filed or finalized copy has that copy's review as its one cover,
  // with no exception for a print with no item that was written before the copy was filed.
  const coverOf = async (albumId) =>
    (await manager.get(`/reviews?album_id=${albumId}`).expect(200)).body.filter((r) => r.on_cover).map((r) => r.id);
  const reviewOf = async (reviewId, albumId) =>
    (await manager.get(`/reviews?album_id=${albumId}`).expect(200)).body.find((r) => r.id === reviewId);

  test('a print with no item written before the release’s one copy was filed stops being on the cover: after the album-page print exactly one review is, the copy’s', async () => {
    const albumId = await release('superseded');
    const earlier = await typedReview(albumId, { review: 'Printed before any copy was logged.' });
    await seedReviewPrint({ album_id: albumId, review_id: earlier.id });
    // No copy: the print with no item is on the cover and holds its review, as before.
    expect(await coverOf(albumId)).toEqual([earlier.id]);
    expect(await reviewOf(earlier.id, albumId)).toMatchObject({ on_cover: true, in_use: true });

    const item = await seedIntakeItem({ state: 'filed', album_id: albumId });
    // One copy, no review accepted for it: nothing is on the cover, and nothing physical depends on the older print.
    expect(await coverOf(albumId)).toEqual([]);
    expect(await reviewOf(earlier.id, albumId)).toMatchObject({ on_cover: false, in_use: false });

    const printed = await typedReview(albumId, { review: 'Printed from the album page.' });
    await manager.post(`/library/${albumId}/print`).send({ review_id: printed.id }).expect(200);
    expect(await coverOf(albumId)).toEqual([printed.id]);
    expect((await itemRow(item.id)).accepted_review_id).toBe(printed.id);
    expect(await reviewOf(earlier.id, albumId)).toMatchObject({ on_cover: false, in_use: false });
    // in_use is what lets its author delete it (the same fragment decides both).
    await djA.delete(`/reviews/${earlier.id}`).expect(204);
  });

  test('a release with two logged copies keeps an earlier print with no item on the cover and in use, as before', async () => {
    const albumId = await release('two-copies-earlier');
    const earlier = await typedReview(albumId, { review: 'Printed before the copies were logged.' });
    await seedReviewPrint({ album_id: albumId, review_id: earlier.id });
    await seedIntakeItem({ state: 'filed', album_id: albumId });
    await seedIntakeItem({ state: 'finalized', album_id: albumId });
    expect(await coverOf(albumId)).toEqual([earlier.id]);
    expect(await reviewOf(earlier.id, albumId)).toMatchObject({ on_cover: true, in_use: true });
    const newer = await typedReview(albumId, { review: 'Printed from the album page.' });
    await manager.post(`/library/${albumId}/print`).send({ review_id: newer.id }).expect(200);
    expect(await coverOf(albumId)).toEqual([newer.id]);
    expect(await reviewOf(earlier.id, albumId)).toMatchObject({ on_cover: false, in_use: false });
  });

  test('a compilation filed under a Various Artists bucket prints its alternate artist name, not the bucket', async () => {
    const bucket = await seedLibraryRelease({
      artist_name: `${PREFIX} Various Artists`,
      album_title: `${PREFIX} compilation`,
      alternate_artist_name: `${PREFIX} Chuquimamani-Condori`,
    });
    const review = await typedReview(bucket.id);
    const res = await manager.post(`/library/${bucket.id}/print`).send({ review_id: review.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      artist_name: `${PREFIX} Chuquimamani-Condori`,
      album_title: `${PREFIX} compilation`,
    });
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
