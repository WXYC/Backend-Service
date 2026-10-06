/**
 * The release, review, revision, print, FCC-note and form-review seeders in `tests/utils/intake_seed.js`:
 * two default releases are distinct, a review, print or note seeded on a release is removed with it, a print
 * or note seeded on an intake item goes with the item, revision numbers continue from the review's own highest,
 * and removal leaves no artist behind.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  removeSeededIntakeItems,
  seedAcceptance,
  managerUserId,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewRevision,
  seedReviewPrint,
  seedFccNote,
  seedFormSubmission,
  removeSeededFormSubmissions,
  SEEDED_CODE_LETTERS,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Every JS, TS, JSON and SQL file under `dir`, recursively (`.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, `.mts`, `.json`,
 * `.sql`), skipping the directories in `skip`. The caller skips `tests/report/`, the gitignored jest-html-reporters
 * output: its `result.js` holds the code frames of the last local run's failures, so a literal that once failed
 * the pin below would otherwise keep failing it after its removal.
 */
function sourceFilesUnder(dir, skip = []) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skip.includes(full) ? [] : sourceFilesUnder(full, skip);
    return /\.([cm]?[jt]s|json|sql)$/.test(entry.name) ? [full] : [];
  });
}

describe('intake_seed release, review, revision, print, FCC-note and form-review seeders', () => {
  afterAll(async () => {
    await removeSeededIntakeItems();
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

  test('a draft review leaves submitted_at NULL', async () => {
    const release = await seedLibraryRelease();
    const draft = await seedReview({ album_id: release.id, status: 'draft' });
    expect(draft.submitted_at).toBeNull();
  });

  test("a seeded artist's code_letters is the exported constant, and neither 'ZZ' nor 'ZQ', which other specs sweep or bucket on", async () => {
    const sql = getTestDb();
    const release = await seedLibraryRelease();
    const [artist] = await sql`SELECT code_letters FROM ${sql(SCHEMA)}.artists WHERE id = ${release.artist_id}`;
    // The row carries the constant the file walk below guards, so the walk guards what seeded artists get.
    expect(artist.code_letters).toBe(SEEDED_CODE_LETTERS);
    // 'ZZ' is swept by album-reviews and digital-archive-playback; 'ZQ' is the BS#2489
    // bucket whose exact membership library.spec.js asserts.
    expect(['ZZ', 'ZQ']).not.toContain(SEEDED_CODE_LETTERS);
  });

  test('no other file under tests/ names the seeded code_letters or imports the constant, so no sweep or bucket assertion can meet one', () => {
    const testsDir = path.resolve(__dirname, '..');
    const owners = [
      path.join(testsDir, 'utils', 'intake_seed.js'),
      path.join(testsDir, 'integration', 'intake-seed.spec.js'),
    ];
    // The value in either quote style, or the exported name: a sweep that imports `SEEDED_CODE_LETTERS` deletes
    // exactly what one that writes the literal would.
    const needle = new RegExp(`SEEDED_CODE_LETTERS|['"]${SEEDED_CODE_LETTERS}['"]`);
    const others = sourceFilesUnder(testsDir, [path.join(testsDir, 'report')]).filter(
      (file) => !owners.includes(file) && needle.test(fs.readFileSync(file, 'utf8'))
    );
    expect(others).toEqual([]);
  });

  test("a revision's default number is its review's highest plus one, not a count or another review's", async () => {
    const release = await seedLibraryRelease();
    // Both submitted: the application gives revisions only to submitted reviews, never to a draft.
    const review = await seedReview({ album_id: release.id });
    const other = await seedReview({ album_id: release.id });
    const first = await seedReviewRevision({ review_id: review.id });
    const second = await seedReviewRevision({ review_id: review.id });
    expect([first.revision, second.revision]).toEqual([1, 2]);
    const explicit = await seedReviewRevision({ review_id: review.id, revision: 5 });
    expect(explicit.revision).toBe(5);
    // Over the gap, MAX + 1 gives 6 where COUNT + 1 would give 4.
    const afterGap = await seedReviewRevision({ review_id: review.id });
    expect(afterGap.revision).toBe(6);
    // The other review's first default is still 1 where a table-wide MAX + 1 would give 7.
    const otherFirst = await seedReviewRevision({ review_id: other.id });
    expect(otherFirst.revision).toBe(1);
  });

  test('revision: null takes the default, as an omitted revision does', async () => {
    const release = await seedLibraryRelease();
    const review = await seedReview({ album_id: release.id });
    const first = await seedReviewRevision({ review_id: review.id, revision: null });
    const second = await seedReviewRevision({ review_id: review.id, revision: null });
    expect([first.revision, second.revision]).toEqual([1, 2]);
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

  test('a print seeded with only an intake item as its target inserts, and goes with the item', async () => {
    const sql = getTestDb();
    const item = await seedIntakeItem();
    const print = await seedReviewPrint({ intake_item_id: item.id });
    expect(print).toMatchObject({ intake_item_id: item.id, album_id: null });

    await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE id = ${item.id}`;

    const prints = await sql`SELECT id FROM ${sql(SCHEMA)}.review_prints WHERE id = ${print.id}`;
    expect(prints).toHaveLength(0);
  });

  test('a note seeded with only an intake item as its target inserts, and goes with the item', async () => {
    const sql = getTestDb();
    const item = await seedIntakeItem();
    const note = await seedFccNote({ intake_item_id: item.id });
    expect(note).toMatchObject({ intake_item_id: item.id, album_id: null, status: 'reported' });

    await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE id = ${item.id}`;

    const notes = await sql`SELECT id FROM ${sql(SCHEMA)}.fcc_notes WHERE id = ${note.id}`;
    expect(notes).toHaveLength(0);
  });

  test('seedAcceptance writes all three accept columns, defaulting to the manager and now, and leaves state alone', async () => {
    const sql = getTestDb();
    // Seeded in 'pool', not 'reviewed': the accept route writes 'reviewed', so an item already there would pass a
    // seedAcceptance that set it.
    const item = await seedIntakeItem();
    const review = await seedReview({ intake_item_id: item.id });
    expect(item.state).toBe('pool');

    const before = Date.now();
    const accepted = await seedAcceptance({ intake_item_id: item.id, review_id: review.id });
    const after = Date.now();

    expect(accepted).toMatchObject({
      state: 'pool',
      accepted_review_id: review.id,
      accepted_by: await managerUserId(),
    });
    expect(accepted.accepted_at).toBeInstanceOf(Date);
    // Now, not a fixed or stale value: the database stamps it, and the Jest process shares its host's clock here.
    expect(accepted.accepted_at.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(accepted.accepted_at.getTime()).toBeLessThanOrEqual(after + 60_000);
    const [row] = await sql`
      SELECT state, accepted_review_id, accepted_by
      FROM ${sql(SCHEMA)}.intake_items WHERE id = ${item.id}`;
    expect(row).toEqual({
      state: 'pool',
      accepted_review_id: review.id,
      accepted_by: await managerUserId(),
    });
  });

  test('seedAcceptance honors an explicit accepted_by and accepted_at', async () => {
    const item = await seedIntakeItem();
    const review = await seedReview({ intake_item_id: item.id });
    const at = new Date('2025-03-06T01:02:03.000Z');

    const accepted = await seedAcceptance({
      intake_item_id: item.id,
      review_id: review.id,
      accepted_by: null,
      accepted_at: at,
    });

    expect(accepted.accepted_by).toBeNull();
    expect(accepted.accepted_at).toEqual(at);
  });

  test('removeSeededIntakeItems deletes every seeded item by id, and a second call is a no-op', async () => {
    const sql = getTestDb();
    const first = await seedIntakeItem();
    const second = await seedIntakeItem();

    await removeSeededIntakeItems();

    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.intake_items WHERE id = ANY(${[first.id, second.id]})`;
    expect(rows).toHaveLength(0);

    // Hand-written because seedIntakeItem would record the id with the remover, and this row must be one the remover was never told about.
    await sql`INSERT INTO ${sql(SCHEMA)}.intake_items ${sql({
      id: first.id,
      artist_name: 'Stereolab',
      album_title: 'Aluminum Tunes',
      format_id: 1,
    })}`;
    try {
      await removeSeededIntakeItems();
      const survivors = await sql`SELECT id FROM ${sql(SCHEMA)}.intake_items WHERE id = ${first.id}`;
      expect(survivors).toHaveLength(1);
    } finally {
      await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE id = ${first.id}`;
    }
  });

  test('a form submission is removed by id', async () => {
    const sql = getTestDb();
    const submission = await seedFormSubmission();
    await removeSeededFormSubmissions();
    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ${submission.id}`;
    expect(rows).toHaveLength(0);
  });
});
