/**
 * The release, review, revision, print, FCC-note and form-review seeders in `tests/utils/intake_seed.js`:
 * two default releases are distinct, a review, print or note seeded on a release is removed with it, and
 * removal leaves no artist behind.
 */

const { getTestDb } = require('../utils/db');
const {
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewRevision,
  seedReviewPrint,
  seedFccNote,
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

  test("a release given only an artist_id carries that artist's name, not the default", async () => {
    const sql = getTestDb();
    const first = await seedLibraryRelease({ artist_name: 'Stereolab', album_title: 'Aluminum Tunes' });
    const second = await seedLibraryRelease({ artist_id: first.artist_id, album_title: 'Dots and Loops' });
    const [artist] = await sql`SELECT artist_name FROM ${sql(SCHEMA)}.artists WHERE id = ${second.artist_id}`;
    expect(artist.artist_name).toBe('Stereolab');
    expect(second.artist_name).toBe('Stereolab');
  });

  test("an explicit artist_name wins over the artist's own name", async () => {
    const first = await seedLibraryRelease({ artist_name: 'Cat Power' });
    const second = await seedLibraryRelease({ artist_id: first.artist_id, artist_name: 'Cat Power with Test Guest' });
    expect(second.artist_name).toBe('Cat Power with Test Guest');
  });

  test('seedReview refuses a review with no target', async () => {
    await expect(seedReview()).rejects.toThrow(/album_id or intake_item_id/);
  });

  test("a draft review leaves submitted_at NULL, and a seeded artist's code_letters is not 'ZZ'", async () => {
    const sql = getTestDb();
    const release = await seedLibraryRelease();
    const draft = await seedReview({ album_id: release.id, status: 'draft' });
    expect(draft.submitted_at).toBeNull();
    const [artist] = await sql`SELECT code_letters FROM ${sql(SCHEMA)}.artists WHERE id = ${release.artist_id}`;
    expect(artist.code_letters).not.toBe('ZZ');
  });

  test('two revisions seeded on one review are numbered 1 and 2', async () => {
    const release = await seedLibraryRelease();
    const review = await seedReview({ album_id: release.id });
    const first = await seedReviewRevision({ review_id: review.id });
    const second = await seedReviewRevision({ review_id: review.id });
    expect([first.revision, second.revision]).toEqual([1, 2]);
    const explicit = await seedReviewRevision({ review_id: review.id, revision: 7 });
    expect(explicit.revision).toBe(7);
  });

  test('the revision, print and note seeders refuse a missing target', async () => {
    await expect(seedReviewRevision()).rejects.toThrow(/review_id/);
    await expect(seedReviewPrint()).rejects.toThrow(/intake_item_id or album_id/);
    await expect(seedFccNote()).rejects.toThrow(/album_id or intake_item_id/);
  });

  test('a print and a note seeded on a release are gone after removal, and a note defaults to reported', async () => {
    const sql = getTestDb();
    const release = await seedLibraryRelease();
    const print = await seedReviewPrint({ album_id: release.id });
    const note = await seedFccNote({ album_id: release.id });
    expect(note.status).toBe('reported');

    await removeSeededLibraryReleases();

    const prints = await sql`SELECT id FROM ${sql(SCHEMA)}.review_prints WHERE id = ${print.id}`;
    const notes = await sql`SELECT id FROM ${sql(SCHEMA)}.fcc_notes WHERE id = ${note.id}`;
    expect(prints).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  test('a form submission is removed by id', async () => {
    const sql = getTestDb();
    const submission = await seedFormSubmission();
    await removeSeededFormSubmissions();
    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ${submission.id}`;
    expect(rows).toHaveLength(0);
  });
});
