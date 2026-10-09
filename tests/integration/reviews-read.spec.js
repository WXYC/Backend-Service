/**
 * `GET /reviews/{id}` and `GET /reviews` (BS#2805, slice 13 of BS#2791). Real Postgres, seeded through
 * tests/utils/intake_seed.js. As in reviews.spec.js, the CI containers run AUTH_BYPASS=true, so the route grants are
 * pinned by tests/unit/routes/reviews-permissions.route.test.ts; this tier pins the SQL: draft privacy on every read,
 * the citation read, the cover-first order and `on_cover`, and `in_use` agreeing with the delete rule. `djA` is a raw
 * user-id Bearer (a non-manager acting as that id). Ids deliberately do not ascend with `submitted_at` (r3 is seeded
 * first) and the visible draft's `last_modified` falls between two submissions, so a list ordered by id alone, or
 * without the `coalesce`, reads differently from the contract's order.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  removeSeededIntakeItems,
  seedAcceptance,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewRevision,
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
  let revs;

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
  };
  const ids = async (who, query) => (await who.get('/reviews').query(query)).body.map((r) => r.id);
  // Only this spec's own rows: `mine` is "everything this user wrote", and other specs write as the same users.
  const ownIds = async (who, query) =>
    (await who.get('/reviews').query(query)).body.filter((r) => r.author?.startsWith(PREFIX)).map((r) => r.id);
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
    // Seeded out of date order on purpose: ids run r3 < r1 < r2 < draftB, `submitted_at` runs r1 < r2 < r3.
    r3 = await review(3);
    r1 = await review(1);
    r2 = await review(2);
    // Three revisions of r3, one per print it will get: [0] for day 11, [1] for day 13, [2] for the backdated day 5.
    revs = [
      await seedReviewRevision({ review_id: r3.id }),
      await seedReviewRevision({ review_id: r3.id }),
      await seedReviewRevision({ review_id: r3.id }),
    ];
    draftB = await seedReview({
      album_id: release.id,
      status: 'draft',
      author: `${PREFIX} draft`,
      author_user_id: global.secondary_dj_id,
      last_modified: new Date(Date.UTC(2026, 0, 2, 12)).toISOString(),
    });
    // The reads under test look only at `accepted_review_id`; null `accepted_by` and `accepted_at` keep the row as this spec has always seeded it.
    await seedAcceptance({ intake_item_id: filedItem.id, review_id: r1.id, accepted_by: null, accepted_at: null });
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
    expect(await ownIds(djB, { mine: 'true' })).toEqual([draftB.id]);
  });

  test('order: the accepted review leads; the rest run by submitted_at, a visible draft by last_modified, not by id', async () => {
    // r1 is on the cover; then r3 (day 3), djB's draft (modified day 2, noon), r2 (day 2). Id order would read r1, draftB, r2, r3.
    expect(await ids(djB, { album_id: release.id })).toEqual([r1.id, r3.id, draftB.id, r2.id]);
    expect(await ids(djA, { album_id: release.id })).toEqual([r1.id, r3.id, r2.id]);
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
    await seedReviewPrint({
      intake_item_id: filedItem.id,
      review_id: r3.id,
      revision_id: revs[0].id,
      printed_at: day(11),
    });
    const list = await albumList(djA, release.id);
    // The accept half: r1 is the item's accepted review, so it is in use and its author may not delete it.
    expect(list.find((r) => r.id === r1.id)).toMatchObject({ in_use: true, on_cover: true });
    expect((await djA.delete(`/reviews/${r1.id}`)).status).toBe(409);
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

    // `copy` has exactly one filed copy (citingItem): a print with no item no longer covers it (BS#3075). r3 stays in use through its print for `release`'s copy.
    await seedReviewPrint({ album_id: copy.id, review_id: r3.id, revision_id: revs[1].id, printed_at: day(13) });
    list = await albumList(djA, copy.id);
    expect(list.find((r) => r.id === r3.id).on_cover).toBe(false);
    expect(list.filter((r) => r.on_cover).map((r) => r.id)).toEqual([r1.id]);
  });

  test('printed_at and printed_revision_id name the latest print by printed_at, not the last one inserted', async () => {
    // r3 has three prints. Inserted order (by id): day 11 -> revs[0], day 13 -> revs[1], then a backdated day 5 -> revs[2].
    // The latest is day 13, which is neither the first nor the last row; ASC order, or id order alone, would name day 5.
    await seedReviewPrint({ album_id: copy.id, review_id: r3.id, revision_id: revs[2].id, printed_at: day(5) });
    const read = (await djA.get(`/reviews/${r3.id}`)).body;
    expect(read.printed_at).toEqual(day(13));
    expect(read.printed_revision_id).toBe(revs[1].id);
    const listed = (await albumList(djA, release.id)).find((r) => r.id === r3.id);
    expect(listed).toMatchObject({ printed_at: day(13), printed_revision_id: revs[1].id });
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
