/**
 * `POST /reviews` on behalf of an author (BS#2866, slice 13e of BS#2791). Real Postgres, seeded through
 * tests/utils/intake_seed.js. The caller is the seeded station manager (`reviews: manage`); the grants themselves
 * are pinned by tests/unit/routes/reviews-permissions.route.test.ts. What this tier pins is the SQL: the accepted
 * create is one transaction (review, revision 1 and the item's accept together or not at all), a review of a
 * filed item carries the release, and that review survives a delete and restore of the release with the item's
 * `accepted_review_id` pointing back at it.
 */

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
  managerAccessToken,
  managerUserId,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-ON-BEHALF';
const TRIGGER = 'itest_on_behalf_fail_accept';

describe('POST /reviews on behalf of an author (BS#2866)', () => {
  let manager;
  let managerId;
  let sql;
  const releaseIds = [];

  const item = (key, overrides = {}) => seedIntakeItem({ artist_name: `${PREFIX} ${key}`, ...overrides });
  const itemRow = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]))[0];
  const reviewsOf = (itemId) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".reviews WHERE intake_item_id = $1 ORDER BY id`, [itemId]);
  const revisionsOf = (reviewId) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".review_revisions WHERE review_id = $1 ORDER BY revision`, [reviewId]);
  const record = (itemId, body = {}) =>
    manager.post('/reviews').send({ intake_item_id: itemId, author: `${PREFIX} author`, ...body });

  const cleanup = async () => {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "${SCHEMA}".intake_items`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS "${SCHEMA}".${TRIGGER}()`);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    if (releaseIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY(${releaseIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_delete_denylist WHERE library_id = ANY(${releaseIds})`;
    }
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

  test('an accepted handwritten review with no text, linked to an account: submitted, revision 1 written, the item reviewed and its holder untouched', async () => {
    const dj = await seedAuthUser();
    const held = await item('accepted', {
      state: 'checked_out',
      checked_out_by: dj.id,
      checked_out_at: new Date().toISOString(),
    });
    const res = await record(held.id, { medium: 'handwritten', author_user_id: dj.id }).expect(200);
    expect(res.body).toMatchObject({
      status: 'submitted',
      medium: 'handwritten',
      review: null,
      author: `${PREFIX} author`,
      author_user_id: dj.id,
      recorded_by_user_id: managerId,
      album_id: null,
      publish_website: false,
      publish_apps: false,
      publish_instagram: false,
      credit: null,
    });
    expect(res.body.submitted_at).not.toBeNull();
    const revisions = await revisionsOf(res.body.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revision: 1, edited_by: `${PREFIX} author`, edited_by_user_id: dj.id });
    expect(await itemRow(held.id)).toMatchObject({
      state: 'reviewed',
      accepted_review_id: res.body.id,
      accepted_by: managerId,
      checked_out_by: dj.id,
    });
  });

  test('accept false leaves a draft and the item as it was', async () => {
    const pooled = await item('draft');
    const res = await record(pooled.id, { review: 'A review.', accept: false }).expect(200);
    expect(res.body).toMatchObject({ status: 'draft', submitted_at: null });
    expect(await revisionsOf(res.body.id)).toEqual([]);
    expect(await itemRow(pooled.id)).toMatchObject({ state: 'pool', accepted_review_id: null });
  });

  test('a typed review with no text and accept in force is a 400 and writes nothing', async () => {
    const pooled = await item('typed-no-text');
    await record(pooled.id, { medium: 'typed' }).expect(400);
    expect(await reviewsOf(pooled.id)).toEqual([]);
    expect(await itemRow(pooled.id)).toMatchObject({ state: 'pool', accepted_review_id: null });
  });

  test('an author_user_id naming no account is a 400 and writes nothing', async () => {
    const pooled = await item('unknown-author');
    await record(pooled.id, { medium: 'handwritten', author_user_id: `${PREFIX}-nobody` }).expect(400);
    expect(await reviewsOf(pooled.id)).toEqual([]);
  });

  test('the accepted create is atomic: a failure on the item write leaves no review, no revision and an unchanged item', async () => {
    const pooled = await item('atomic');
    await sql.unsafe(
      `CREATE FUNCTION "${SCHEMA}".${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure after the insert'; END $$`
    );
    await sql.unsafe(
      `CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON "${SCHEMA}".intake_items FOR EACH ROW WHEN (NEW.id = ${Number(pooled.id)} AND NEW.accepted_review_id IS NOT NULL) EXECUTE FUNCTION "${SCHEMA}".${TRIGGER}()`
    );
    try {
      const res = await record(pooled.id, { medium: 'handwritten' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "${SCHEMA}".intake_items`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS "${SCHEMA}".${TRIGGER}()`);
    }
    expect(await reviewsOf(pooled.id)).toEqual([]);
    expect(await itemRow(pooled.id)).toMatchObject({ state: 'pool', accepted_review_id: null, accepted_by: null });
  });

  test('a review recorded on a filed item carries its release, and survives deleting the release and restoring the batch', async () => {
    const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` });
    releaseIds.push(release.id);
    const filed = await item('filed', { state: 'filed', album_id: release.id });
    const res = await record(filed.id, { medium: 'handwritten' }).expect(200);
    expect(res.body).toMatchObject({ status: 'submitted', intake_item_id: filed.id, album_id: release.id });
    expect(await itemRow(filed.id)).toMatchObject({ state: 'filed', accepted_review_id: res.body.id });

    await manager.delete(`/library/${release.id}`).expect(204);
    const [{ batch_id: batchId }] = await sql`
      SELECT batch_id FROM ${sql(SCHEMA)}.catalog_delete_snapshot
      WHERE entity_kind = 'library' AND entity_id = ${release.id} ORDER BY id DESC LIMIT 1`;
    await manager.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    const [restored] = await reviewsOf(filed.id);
    expect(restored).toMatchObject({ intake_item_id: filed.id, album_id: release.id, author: `${PREFIX} author` });
    expect(await itemRow(filed.id)).toMatchObject({ state: 'filed', accepted_review_id: restored.id });
  });
});
