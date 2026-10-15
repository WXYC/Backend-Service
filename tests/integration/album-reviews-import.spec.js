/**
 * The album-reviews import (BS#3132) against a real Postgres: which archive rows are copied into `reviews`, what
 * each copy carries, that a dry run writes nothing and that a second run is a no-op.
 *
 * Runs the REAL shipped `runImport` from `jobs/album-reviews-import/dist/import.cjs` (CI's Build step produces it;
 * locally, `npm run build --workspace=@wxyc/album-reviews-import` first). It takes this spec's own postgres.js
 * handle. Rows come from `tests/utils/intake_seed.js`.
 *
 * The job reads every archive row in the schema, so counts are asserted as deltas over a dry run taken before this
 * spec seeds anything, and each row is asserted by id. Whatever the apply wrote is removed in `afterAll`.
 *
 * The last case stands in for a release deleted while `--apply` runs: it wraps this spec's handle so that, just before
 * one row's insert, the row's `album_id` is set NULL on another connection, as the `ON DELETE SET NULL` of a release
 * delete that committed after the scan would.
 */

// The unit-tier drizzle-orm double sits under tests/__mocks__ and jest applies it to node modules here too. The import
// bundle and `@wxyc/database` need the real package.
jest.unmock('drizzle-orm');

const path = require('path');
const { AUTHOR_MAX } = require('@wxyc/database');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedFormSubmission,
  removeSeededFormSubmissions,
} = require('../utils/intake_seed');

const { runImport } = require(path.join(__dirname, '..', '..', 'jobs', 'album-reviews-import', 'dist', 'import.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('album-reviews import (real PG)', () => {
  let sql;
  let release;
  let base;
  const rows = {};
  const run = (apply) => runImport(sql, { schema: SCHEMA, apply, log: () => {} });
  const reviewCount = async () => (await sql`SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.reviews`)[0].n;
  const importedReview = async (submission) =>
    (
      await sql`SELECT *, add_date::text AS add_date_text FROM ${sql(SCHEMA)}.reviews WHERE imported_from_submission_id = ${submission.id}`
    )[0];
  const revisionsOf = (reviewId) =>
    sql`SELECT * FROM ${sql(SCHEMA)}.review_revisions WHERE review_id = ${reviewId} ORDER BY revision`;

  beforeAll(async () => {
    sql = getTestDb();
    release = await seedLibraryRelease();
    base = await run(false);

    const linked = { album_id: release.id, review: 'A form review.' };
    // 2025-01-01 03:30 UTC is still 31 December in New York, so the add_date proves the zone and not the UTC date.
    rows.full = await seedFormSubmission({
      ...linked,
      artist_blurb: 'A blurb.',
      recommended_tracks: 'la paradoja (!!!!)',
      buzzwords: 'hushed, rural',
      fcc_violations: 'Track 3',
      reviewer_raw: '  Test Reviewer  ',
      social_consent: true,
      submitted_at: '2025-01-01T03:30:00+00:00',
    });
    rows.no = await seedFormSubmission({ ...linked, reviewer_raw: '   ', social_consent: false, submitted_at: null });
    rows.unknown = await seedFormSubmission({ ...linked, social_consent: null });
    rows.unlinked = await seedFormSubmission({ review: 'A form review.', reviewer_raw: 'Test Reviewer' });
    rows.blank = await seedFormSubmission({ ...linked, review: '  \n ' });
    rows.cited = await seedFormSubmission(linked);
    await seedIntakeItem({ cited_submission_id: rows.cited.id });
    rows.tooLong = await seedFormSubmission({ ...linked, reviewer_raw: 'x'.repeat(AUTHOR_MAX + 1) });
    // 128 code points is 256 UTF-16 units, and Postgres counts characters, so this one fits.
    rows.astral = await seedFormSubmission({ ...linked, reviewer_raw: '𝒜'.repeat(AUTHOR_MAX) });
  });

  afterAll(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.reviews WHERE imported_from_submission_id IS NOT NULL`;
    await removeSeededIntakeItems();
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  });

  test('a dry run counts each rule and writes nothing', async () => {
    const before = await reviewCount();

    const dry = await run(false);

    expect(await reviewCount()).toBe(before);
    expect(dry.status).toBe('dry-run');
    expect(dry.eligible - base.eligible).toBe(5);
    expect(dry.imported - base.imported).toBe(4);
    for (const [reason, added] of [
      ['no_release', 1],
      ['blank_review', 1],
      ['cited_by_intake_item', 1],
      ['already_imported', 0],
      ['author_too_long', 1],
    ]) {
      expect({ reason, n: dry.skipped[reason] - base.skipped[reason] }).toEqual({ reason, n: added });
    }
    expect(dry.tooLongAuthors).toContain(rows.tooLong.id);
    expect(await importedReview(rows.full)).toBeUndefined();
  });

  test('--apply copies a linked row with every column mapped, and its revision 1', async () => {
    const applied = await run(true);

    expect(applied.status).toBe('applied');
    expect(applied.imported - base.imported).toBe(4);
    const review = await importedReview(rows.full);
    expect(review).toMatchObject({
      album_id: release.id,
      intake_item_id: null,
      review: 'A form review.',
      artist_blurb: 'A blurb.',
      recommended_tracks: 'la paradoja (!!!!)',
      buzzwords: 'hushed, rural',
      fcc: 'Track 3',
      author: 'Test Reviewer',
      author_user_id: null,
      recorded_by_user_id: null,
      medium: 'typed',
      status: 'submitted',
      publish_website: true,
      publish_apps: true,
      publish_instagram: true,
      credit: 'none',
    });
    expect(review.submitted_at).toEqual(rows.full.submitted_at);
    expect(review.add_date_text).toBe('2024-12-31');
    const revisions = await revisionsOf(review.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      revision: 1,
      edited_by: 'Test Reviewer',
      edited_by_user_id: null,
      review: 'A form review.',
      artist_blurb: 'A blurb.',
      recommended_tracks: 'la paradoja (!!!!)',
      buzzwords: 'hushed, rural',
      fcc: 'Track 3',
    });
    expect(revisions[0].edited_at).toEqual(rows.full.submitted_at);
  });

  test.each([
    ['yes', 'full', true],
    ['no', 'no', false],
    ['unanswered', 'unknown', false],
  ])('a %s consent gives all three publish flags %s and no credit', async (_name, key, expected) => {
    const review = await importedReview(rows[key]);

    expect([review.publish_website, review.publish_apps, review.publish_instagram]).toEqual([
      expected,
      expected,
      expected,
    ]);
    expect(review.credit).toBe('none');
  });

  test('a blank reviewer is a null author, and a row with no submitted_at keeps it null', async () => {
    const review = await importedReview(rows.no);

    expect(review.author).toBeNull();
    expect(review.submitted_at).toBeNull();
    const [revision] = await revisionsOf(review.id);
    expect(revision.edited_by).toBeNull();
    expect(Math.abs(Date.now() - revision.edited_at.getTime())).toBeLessThan(10 * 60 * 1000);
  });

  test('an author of exactly AUTHOR_MAX code points is imported whole', async () => {
    const review = await importedReview(rows.astral);

    expect([...review.author]).toHaveLength(AUTHOR_MAX);
  });

  test.each(['unlinked', 'blank', 'cited', 'tooLong'])('the %s row is not imported', async (key) => {
    expect(await importedReview(rows[key])).toBeUndefined();
  });

  test('a second run inserts nothing and reports every eligible row as already imported', async () => {
    const before = await reviewCount();

    const again = await run(true);

    expect(await reviewCount()).toBe(before);
    expect(again.imported).toBe(0);
    expect(again.skipped.already_imported).toBe(again.eligible - again.skipped.author_too_long);
    expect(again.eligible - base.eligible).toBe(5);
  });

  test('deleting the form row clears the provenance and keeps the review', async () => {
    const review = await importedReview(rows.astral);

    await sql`DELETE FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ${rows.astral.id}`;

    const [after] = await sql`SELECT * FROM ${sql(SCHEMA)}.reviews WHERE id = ${review.id}`;
    expect(after.imported_from_submission_id).toBeNull();
  });

  test('a row whose release is deleted after the scan is counted under no_release, and the run still commits', async () => {
    const raced = await seedFormSubmission({
      album_id: release.id,
      review: 'A form review.',
      reviewer_raw: 'Test Raced',
    });
    const pre = await run(false);
    const before = await reviewCount();
    const releaseDeletedBeforeInsert = (db) =>
      new Proxy(db, {
        get: (target, prop) =>
          prop === 'begin'
            ? (mode, fn) =>
                target.begin(mode, (tx) =>
                  fn(
                    new Proxy(tx, {
                      // Synchronous for everything but the raced row's insert: the job also calls `tx` for identifiers and fragments.
                      apply: (query, self, args) => {
                        const isInsert = Array.isArray(args[0]) && args[0].join('').includes('WITH imported AS');
                        if (!isInsert || !args.includes(raced.id)) return Reflect.apply(query, self, args);
                        return db`UPDATE ${db(SCHEMA)}.album_review_submissions SET album_id = NULL WHERE id = ${raced.id}`.then(
                          () => Reflect.apply(query, self, args)
                        );
                      },
                    })
                  )
                )
            : Reflect.get(target, prop),
      });

    const result = await runImport(releaseDeletedBeforeInsert(sql), { schema: SCHEMA, apply: true, log: () => {} });

    expect(await reviewCount()).toBe(before);
    expect(await importedReview(raced)).toBeUndefined();
    expect(pre.imported).toBe(1);
    expect(result.eligible).toBe(pre.eligible);
    expect(result.imported).toBe(0);
    expect(result.skipped.no_release - pre.skipped.no_release).toBe(1);
    expect(result.skipped.already_imported).toBe(pre.skipped.already_imported);
  });
});

// Which citing intake items keep a form row out of the import (BS#3164; the rule is in ADR 0011): one that is unfiled or
// filed as the row's own release. Each case seeds its own row and its own citing items, then takes a dry run and an
// `--apply` against counts read just before the row existed, so the cases do not depend on each other or on the order.
describe('album-reviews import: the citation skip (real PG)', () => {
  let sql;
  let release;
  let other;
  const run = (apply) => runImport(sql, { schema: SCHEMA, apply, log: () => {} });
  const importedCount = async (submission) =>
    (
      await sql`SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.reviews WHERE imported_from_submission_id = ${submission.id}`
    )[0].n;

  beforeAll(async () => {
    sql = getTestDb();
    release = await seedLibraryRelease();
    other = await seedLibraryRelease({ artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' });
  });

  afterAll(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.reviews WHERE imported_from_submission_id IS NOT NULL`;
    await removeSeededIntakeItems();
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  });

  test.each([
    ['an unfiled item', 'skipped', [{ state: 'pool' }]],
    ['an item checked out and not yet filed', 'skipped', [{ state: 'reviewed' }]],
    ['an item filed as the row’s own release', 'skipped', [{ state: 'filed', album: 'own' }]],
    ['an item finalized as the row’s own release', 'skipped', [{ state: 'finalized', album: 'own' }]],
    ['an item filed as another release', 'imported', [{ state: 'filed', album: 'other' }]],
    ['an item finalized as another release', 'imported', [{ state: 'finalized', album: 'other' }]],
    ['one item filed elsewhere and one unfiled', 'skipped', [{ state: 'filed', album: 'other' }, { state: 'pool' }]],
    [
      'one item filed elsewhere and one filed as the row’s own release',
      'skipped',
      [
        { state: 'filed', album: 'other' },
        { state: 'filed', album: 'own' },
      ],
    ],
  ])('a row cited by %s is %s, as a dry run and under --apply', async (_name, outcome, items) => {
    const pre = await run(false);
    const row = await seedFormSubmission({
      album_id: release.id,
      review: 'A form review.',
      reviewer_raw: 'Test Reviewer',
    });
    for (const { state, album } of items) {
      await seedIntakeItem({
        cited_submission_id: row.id,
        state,
        ...(album && { album_id: (album === 'own' ? release : other).id }),
      });
    }
    const delta = (result) => ({
      cited: result.skipped.cited_by_intake_item - pre.skipped.cited_by_intake_item,
      eligible: result.eligible - pre.eligible,
      imported: result.imported - pre.imported,
    });
    const expected =
      outcome === 'imported' ? { cited: 0, eligible: 1, imported: 1 } : { cited: 1, eligible: 0, imported: 0 };

    const dry = await run(false);

    expect(delta(dry)).toEqual(expected);
    expect(await importedCount(row)).toBe(0);

    const applied = await run(true);

    expect(applied.status).toBe('applied');
    expect(delta(applied)).toEqual(expected);
    expect(await importedCount(row)).toBe(outcome === 'imported' ? 1 : 0);
  });

  test('a row skipped for an unfiled item is imported by a later run once the item is filed as another release', async () => {
    const row = await seedFormSubmission({
      album_id: release.id,
      review: 'A form review.',
      reviewer_raw: 'Test Reviewer',
    });
    const item = await seedIntakeItem({ cited_submission_id: row.id, state: 'pool' });

    await run(true);
    expect(await importedCount(row)).toBe(0);

    await sql`UPDATE ${sql(SCHEMA)}.intake_items SET state = 'filed', album_id = ${other.id} WHERE id = ${item.id}`;
    await run(true);
    expect(await importedCount(row)).toBe(1);

    const again = await run(true);
    expect(again.imported).toBe(0);
    expect(await importedCount(row)).toBe(1);
  });
});
