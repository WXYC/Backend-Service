/**
 * Integration tests for `review_revisions`, `review_prints`, `fcc_notes` and the
 * accepted-review columns on `intake_items` (slice 9b of
 * WXYC/Backend-Service#2791, issue #2858), against a real Postgres. The unit
 * tier cannot see any of this: it is all constraint behaviour the database
 * enforces.
 *
 *   - `review_prints_target_ck` and `fcc_notes_target_ck`,
 *   - `UNIQUE (review_id, revision)`,
 *   - each CASCADE and each SET NULL the issue lists,
 *   - the reviews <-> intake_items cycle: deleting an item whose
 *     `accepted_review_id` points at one of its own reviews succeeds and
 *     removes both.
 *
 * Seeds and asserts through the `getTestDb()` pool; every row is removed in
 * `afterEach`.
 */

const { getTestDb } = require('../utils/db');
const {
  seedAuthUser,
  removeSeededAuthUsers,
  seedIntakeItem,
  removeSeededIntakeItems,
  seedAcceptance,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewRevision,
  seedReviewPrint,
  seedFccNote,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Scopes this spec's items, so a sibling spec running in parallel never has its rows deleted.
const ITEM_ARTIST = 'BS#2858 Cat Power';

describe('review_revisions, review_prints, fcc_notes (real PG)', () => {
  let sql;

  const t = (name) => sql`${sql(SCHEMA)}.${sql(name)}`;

  const getRow = async (name, id) => (await sql`SELECT * FROM ${t(name)} WHERE id = ${id}`)[0];

  beforeAll(async () => {
    sql = getTestDb();
  });

  afterEach(async () => {
    // Items and library rows cascade to everything below them; the accepted
    // pointer SETs NULL, so deleting items first is safe.
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
    await removeSeededAuthUsers();
  });

  describe('CHECK constraints', () => {
    it('rejects a print with neither an item nor a release', async () => {
      // Hand-written: seedReviewPrint refuses a print with no target on purpose, and this test needs the CHECK to fire.
      await expect(sql`INSERT INTO ${t('review_prints')} DEFAULT VALUES`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'review_prints_target_ck',
      });
    });

    it('rejects an FCC note with neither a release nor an item', async () => {
      // Hand-written: seedFccNote refuses a note with no target on purpose, and this test needs the CHECK to fire.
      await expect(
        sql`INSERT INTO ${t('fcc_notes')} ${sql({ track: 'la paradoja', note: 'a note', reported_by: 'Test Reporter' })}`
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'fcc_notes_target_ck' });
    });

    it('rejects an FCC note with no reporter name (BS#2862)', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      await expect(seedFccNote({ intake_item_id: item.id, reported_by: null })).rejects.toMatchObject({
        code: '23502',
        column_name: 'reported_by',
      });
    });

    it('accepts a print for a release with no intake item', async () => {
      const printId = (await seedReviewPrint({ album_id: (await seedLibraryRelease()).id })).id;
      expect((await getRow('review_prints', printId)).intake_item_id).toBeNull();
    });

    it('accepts an FCC note on a pile item, defaulting its status to reported', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const note = await getRow('fcc_notes', (await seedFccNote({ intake_item_id: item.id })).id);
      expect(note.status).toBe('reported');
    });
  });

  describe('UNIQUE (review_id, revision)', () => {
    it('rejects a second copy of one revision number and accepts the next', async () => {
      const reviewId = (await seedReview({ album_id: (await seedLibraryRelease()).id })).id;
      await seedReviewRevision({ review_id: reviewId, revision: 1 });

      await expect(seedReviewRevision({ review_id: reviewId, revision: 1 })).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'review_revisions_review_id_revision_unique',
      });
      await expect(seedReviewRevision({ review_id: reviewId, revision: 2 })).resolves.toBeDefined();
    });
  });

  describe('CASCADE', () => {
    it('deletes a review’s revisions with it', async () => {
      const reviewId = (await seedReview({ album_id: (await seedLibraryRelease()).id })).id;
      const revisionId = (await seedReviewRevision({ review_id: reviewId })).id;

      await sql`DELETE FROM ${t('reviews')} WHERE id = ${reviewId}`;

      expect(await getRow('review_revisions', revisionId)).toBeUndefined();
    });

    it.each([['review_prints'], ['fcc_notes']])('deletes %s with the release they name', async (name) => {
      const albumId = (await seedLibraryRelease()).id;
      const id = (await (name === 'review_prints' ? seedReviewPrint : seedFccNote)({ album_id: albumId })).id;

      await sql`DELETE FROM ${t('library')} WHERE id = ${albumId}`;

      expect(await getRow(name, id)).toBeUndefined();
    });

    it.each([['review_prints'], ['fcc_notes']])('deletes %s with the intake item they name', async (name) => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const id = (await (name === 'review_prints' ? seedReviewPrint : seedFccNote)({ intake_item_id: item.id })).id;

      await sql`DELETE FROM ${t('intake_items')} WHERE id = ${item.id}`;

      expect(await getRow(name, id)).toBeUndefined();
    });
  });

  describe('SET NULL', () => {
    it('keeps a print when its review and revision are deleted', async () => {
      const albumId = (await seedLibraryRelease()).id;
      const reviewId = (await seedReview({ album_id: albumId })).id;
      const revisionId = (await seedReviewRevision({ review_id: reviewId })).id;
      const printId = (await seedReviewPrint({ album_id: albumId, review_id: reviewId, revision_id: revisionId })).id;

      await sql`DELETE FROM ${t('review_revisions')} WHERE id = ${revisionId}`;
      expect(await getRow('review_prints', printId)).toMatchObject({ review_id: reviewId, revision_id: null });

      await sql`DELETE FROM ${t('reviews')} WHERE id = ${reviewId}`;
      expect(await getRow('review_prints', printId)).toMatchObject({ review_id: null, revision_id: null });
    });

    it.each([
      ['review_revisions', 'edited_by_user_id'],
      ['review_prints', 'printed_by'],
      ['fcc_notes', 'reported_by_user_id'],
      ['intake_items', 'accepted_by'],
    ])('nulls %s.%s when the account is deleted', async (name, column) => {
      const userId = (await seedAuthUser()).id;
      const albumId = (await seedLibraryRelease()).id;
      const id = await {
        review_revisions: async () =>
          (await seedReviewRevision({ review_id: (await seedReview({ album_id: albumId })).id, [column]: userId })).id,
        review_prints: async () => (await seedReviewPrint({ album_id: albumId, [column]: userId })).id,
        fcc_notes: async () => (await seedFccNote({ album_id: albumId, [column]: userId })).id,
        intake_items: async () => (await seedIntakeItem({ artist_name: ITEM_ARTIST, [column]: userId })).id,
      }[name]();

      await sql`DELETE FROM auth_user WHERE id = ${userId}`;

      const after = await getRow(name, id);
      expect(after).toBeDefined();
      expect(after[column]).toBeNull();
    });
  });

  describe('intake_items.accepted_review_id', () => {
    it('is NULL on a new item and takes the accept columns', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      expect(item).toMatchObject({ accepted_review_id: null, accepted_by: null, accepted_at: null });
    });

    it('nulls the pointer, keeping the item, when the accepted review is deleted', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const reviewId = (await seedReview({ intake_item_id: item.id })).id;
      await seedAcceptance({ intake_item_id: item.id, review_id: reviewId });

      await sql`DELETE FROM ${t('reviews')} WHERE id = ${reviewId}`;

      expect(await getRow('intake_items', item.id)).toMatchObject({ accepted_review_id: null });
    });

    it('deletes an item whose accepted review is one of its own, removing both', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const reviewId = (await seedReview({ intake_item_id: item.id })).id;
      await seedAcceptance({ intake_item_id: item.id, review_id: reviewId });

      await sql`DELETE FROM ${t('intake_items')} WHERE id = ${item.id}`;

      expect(await getRow('intake_items', item.id)).toBeUndefined();
      expect(await getRow('reviews', reviewId)).toBeUndefined();
    });
  });
});
