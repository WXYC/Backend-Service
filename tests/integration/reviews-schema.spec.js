/**
 * Integration tests for the extended `reviews` table (slice 9 of
 * WXYC/Backend-Service#2791, issue #2801), against a real Postgres. The unit
 * tier cannot see any of this: it is all constraint behaviour the database
 * enforces.
 *
 *   - many reviews per release, now that `UNIQUE (album_id)` is gone,
 *   - `reviews_target_ck`: a review points at a release or an intake item,
 *   - `intake_item_id` cascading when its item is deleted,
 *   - `author_user_id` and `recorded_by_user_id` nulling when the account is
 *     deleted, with the `author` text kept,
 *   - the defaults a row that predates the new columns reads back with.
 *
 * Every row is removed in `afterEach`.
 */

const { getTestDb } = require('../utils/db');
const {
  seedAuthUser,
  removeSeededAuthUsers,
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('reviews schema (real PG)', () => {
  let sql;

  const seedUser = async () => (await seedAuthUser({ name: 'Reviews Test' })).id;

  const seedItem = async () => (await seedIntakeItem({ artist_name: 'Juana Molina', album_title: 'DOGA' })).id;

  const getReview = async (id) => (await sql`SELECT * FROM ${sql(SCHEMA)}.reviews WHERE id = ${id}`)[0];

  beforeAll(async () => {
    sql = getTestDb();
  });

  afterEach(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE artist_name = 'Juana Molina'`;
    await removeSeededLibraryReleases();
    await removeSeededAuthUsers();
  });

  it('reads back the stub-era defaults on a row that names only the columns the stub had', async () => {
    const album = (await seedLibraryRelease()).id;
    const review = await seedReview({ album_id: album });
    expect(review).toMatchObject({
      status: 'submitted',
      medium: 'typed',
      publish_website: false,
      publish_apps: false,
      publish_instagram: false,
      credit: null,
      intake_item_id: null,
      author_user_id: null,
      recorded_by_user_id: null,
    });
  });

  it('allows many reviews per release', async () => {
    const album = (await seedLibraryRelease()).id;
    await seedReview({ album_id: album, author: 'first' });
    await seedReview({ album_id: album, author: 'second' });
    const rows = await sql`SELECT 1 FROM ${sql(SCHEMA)}.reviews WHERE album_id = ${album}`;
    expect(rows).toHaveLength(2);
  });

  describe('reviews_target_ck', () => {
    it('rejects a review that points at neither a release nor an intake item', async () => {
      // Hand-written: seedReview refuses a review with no target on purpose, and this test needs the CHECK to fire.
      await expect(sql`INSERT INTO ${sql(SCHEMA)}.reviews ${sql({ review: 'la paradoja' })}`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'reviews_target_ck',
      });
    });

    it('accepts a review on an intake item alone, before any library row exists', async () => {
      const item = await seedItem();
      const review = await seedReview({ intake_item_id: item });
      expect(review.album_id).toBeNull();
    });

    it('rejects clearing both pointers on an existing review', async () => {
      const review = await seedReview({ album_id: (await seedLibraryRelease()).id });
      await expect(
        sql`UPDATE ${sql(SCHEMA)}.reviews SET album_id = NULL WHERE id = ${review.id}`
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'reviews_target_ck' });
    });
  });

  it('deletes an intake item’s reviews with it', async () => {
    const item = await seedItem();
    const review = await seedReview({ intake_item_id: item });
    await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE id = ${item}`;
    expect(await getReview(review.id)).toBeUndefined();
  });

  it.each([['author_user_id'], ['recorded_by_user_id']])(
    'nulls %s when the account is deleted and keeps the author text',
    async (column) => {
      const user = await seedUser();
      const review = await seedReview({
        album_id: (await seedLibraryRelease()).id,
        author: 'Cat Power',
        [column]: user,
      });
      await sql`DELETE FROM auth_user WHERE id = ${user}`;
      const after = await getReview(review.id);
      expect(after[column]).toBeNull();
      expect(after.author).toBe('Cat Power');
    }
  );

  it('rejects a status outside draft/submitted', async () => {
    await expect(seedReview({ album_id: (await seedLibraryRelease()).id, status: 'published' })).rejects.toMatchObject({
      code: '22P02',
    });
  });
});
