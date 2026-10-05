/**
 * The release, review and form-review seeders in `tests/utils/intake_seed.js`: two default releases
 * are distinct, a review seeded on one is removed with it, and removal leaves no artist behind.
 */

const { getTestDb } = require('../utils/db');
const {
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedFormSubmission,
  removeSeededFormSubmissions,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('intake_seed release, review and form-review seeders', () => {
  afterAll(async () => {
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  });

  test('two default releases differ, and removal leaves neither release, artist nor review behind', async () => {
    const sql = getTestDb();
    const first = await seedLibraryRelease();
    const second = await seedLibraryRelease();
    expect(first.id).not.toBe(second.id);
    expect(first.artist_id).not.toBe(second.artist_id);
    const review = await seedReview({ album_id: first.id });
    expect(review).toMatchObject({ status: 'submitted', medium: 'typed', author: 'Test Reviewer' });
    expect(review.submitted_at).not.toBeNull();

    await removeSeededLibraryReleases();

    const count = async (table, column, ids) =>
      (await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".${table} WHERE ${column} = ANY($1)`, [ids]))[0].n;
    expect(await count('library', 'id', [first.id, second.id])).toBe(0);
    expect(await count('artists', 'id', [first.artist_id, second.artist_id])).toBe(0);
    expect(await count('reviews', 'id', [review.id])).toBe(0);
  });

  test('a release given an artist_id reuses that artist', async () => {
    const first = await seedLibraryRelease();
    const second = await seedLibraryRelease({ artist_id: first.artist_id });
    expect(second.artist_id).toBe(first.artist_id);
  });

  test('seedReview refuses a review with no target', async () => {
    await expect(seedReview()).rejects.toThrow(/album_id or intake_item_id/);
  });

  test('a form submission is removed by id', async () => {
    const sql = getTestDb();
    const submission = await seedFormSubmission();
    await removeSeededFormSubmissions();
    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ${submission.id}`;
    expect(rows).toHaveLength(0);
  });
});
