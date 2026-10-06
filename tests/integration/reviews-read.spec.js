/**
 * `GET /reviews/{id}` and `GET /reviews` (BS#2805, slice 13 of BS#2791). Real Postgres, seeded through
 * tests/utils/intake_seed.js. As in reviews.spec.js, the CI containers run AUTH_BYPASS=true, so the route grants are
 * pinned by tests/unit/routes/reviews-permissions.route.test.ts; this tier pins the SQL: draft privacy on every read,
 * the citation read, the cover-first order and `on_cover`, and `in_use` agreeing with the delete rule. `djA` is a raw
 * user-id Bearer (a non-manager acting as that id).
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewPrint,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-REVIEWS-READ';
const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();

describe('/reviews reads (BS#2805)', () => {
  let manager;
  let djA;
  let djB;
  let sql;
  let release;
  let copy;
  let filedItem;
  let citingItem;
  let r1;
  let r2;
  let r3;
  let draftB;

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await removeSeededLibraryReleases();
  };
  const ids = async (who, query) => (await who.get('/reviews').query(query)).body.map((r) => r.id);
  const albumList = async (who, albumId) => (await who.get('/reviews').query({ album_id: albumId })).body;

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    await cleanup();
    release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` });
    copy = await seedLibraryRelease({ artist_id: release.artist_id, album_title: `${PREFIX} copy` });
    filedItem = await seedIntakeItem({ artist_name: `${PREFIX} filed`, state: 'filed', album_id: release.id });
    citingItem = await seedIntakeItem({
      artist_name: `${PREFIX} citing`,
      state: 'filed',
      album_id: copy.id,
      cited_album_id: release.id,
    });
    const review = (n, extra = {}) =>
      seedReview({
        album_id: release.id,
        intake_item_id: filedItem.id,
        author: `${PREFIX} author`,
        author_user_id: global.primary_dj_id,
        submitted_at: day(n),
        ...extra,
      });
    r1 = await review(1);
    r2 = await review(2);
    r3 = await review(3);
    draftB = await seedReview({
      album_id: release.id,
      status: 'draft',
      author: `${PREFIX} draft`,
      author_user_id: global.secondary_dj_id,
    });
    await sql.unsafe(`UPDATE "${SCHEMA}".intake_items SET accepted_review_id = $1 WHERE id = $2`, [
      r1.id,
      filedItem.id,
    ]);
  });

  afterAll(cleanup);

  test("another DJ's draft is a 404 by id for everyone but its author, a music director included", async () => {
    expect((await djA.get(`/reviews/${draftB.id}`)).status).toBe(404);
    expect((await manager.get(`/reviews/${draftB.id}`)).status).toBe(404);
    expect((await djB.get(`/reviews/${draftB.id}`)).status).toBe(200);
  });

  test("a draft is on no list another user can call, and is on its author's own", async () => {
    for (const who of [djA, manager]) {
      expect(await ids(who, { album_id: release.id })).not.toContain(draftB.id);
      expect(await ids(who, {})).not.toContain(draftB.id);
      expect(await ids(who, { mine: 'true' })).not.toContain(draftB.id);
    }
    expect(await ids(djB, { album_id: release.id })).toContain(draftB.id);
    expect(await ids(djB, { mine: 'true' })).toEqual([draftB.id]);
  });

  test('the accepted review leads the album list although the newest is not it; a print of another review joins it', async () => {
    let list = await albumList(djA, release.id);
    expect(list.map((r) => r.id)).toEqual([r1.id, r3.id, r2.id]);
    expect(list.map((r) => r.on_cover)).toEqual([true, false, false]);
    expect(list.map((r) => r.in_use)).toEqual([true, false, false]);

    await seedReviewPrint({ intake_item_id: filedItem.id, review_id: r2.id, printed_at: day(10) });
    list = await albumList(djA, release.id);
    expect(list.map((r) => r.id)).toEqual([r2.id, r1.id, r3.id]);
    expect(list.map((r) => r.on_cover)).toEqual([true, true, false]);
    expect(list.find((r) => r.id === r2.id).printed_at).toEqual(day(10));
    expect(list.find((r) => r.id === r1.id)).toMatchObject({ printed_at: null, printed_revision_id: null });
  });

  test('in_use is false for a print a newer one replaced, and agrees with the delete rule', async () => {
    await seedReviewPrint({ intake_item_id: filedItem.id, review_id: r3.id, printed_at: day(11) });
    const list = await albumList(djA, release.id);
    expect(list.find((r) => r.id === r2.id)).toMatchObject({ in_use: false, on_cover: false });
    expect(list.find((r) => r.id === r3.id)).toMatchObject({ in_use: true, on_cover: true });
    expect((await djA.get(`/reviews/${r3.id}`)).body).toMatchObject({ in_use: true, on_cover: false });
    expect((await djA.delete(`/reviews/${r3.id}`)).status).toBe(409);
    expect((await djA.delete(`/reviews/${r2.id}`)).status).toBe(204);
  });

  test("a cited release's reviews are listed on the citing release, in use but not on its cover until chosen or printed for it", async () => {
    let list = await albumList(djA, copy.id);
    expect(list.map((r) => r.id).sort()).toEqual([r1.id, r3.id].sort());
    expect(list.every((r) => r.on_cover === false)).toBe(true);
    expect(list.find((r) => r.id === r1.id).in_use).toBe(true);

    await seedReviewPrint({ intake_item_id: citingItem.id, review_id: r1.id, printed_at: day(12) });
    list = await albumList(djA, copy.id);
    expect(list[0]).toMatchObject({ id: r1.id, on_cover: true });

    await seedReviewPrint({ album_id: copy.id, review_id: r3.id, printed_at: day(13) });
    list = await albumList(djA, copy.id);
    expect(list.find((r) => r.id === r3.id).on_cover).toBe(true);
  });

  test('the other lists are newest first with on_cover false, and the filters combine', async () => {
    const byItem = (await djA.get('/reviews').query({ intake_item_id: filedItem.id })).body;
    expect(byItem.map((r) => r.id)).toEqual([r3.id, r1.id]);
    expect(byItem.every((r) => r.on_cover === false)).toBe(true);
    expect(await ids(djB, { mine: 'true', album_id: release.id })).toEqual([draftB.id]);
    expect(await ids(djB, { mine: 'false', intake_item_id: filedItem.id })).toEqual([r3.id, r1.id]);
  });

  test.each(['album_id=2147483648', 'intake_item_id=0', 'mine=maybe'])('%s is a 400', async (query) => {
    expect((await djA.get(`/reviews?${query}`)).status).toBe(400);
  });
});
