/**
 * Integration tests for the cover-review copy in DELETE /library/:id (BS#2875, slice 10f of
 * BS#2791). A record that took its cover review from a release (`intake_items.accepted_review_id`
 * names a review whose `album_id` is that release) keeps a complete copy of it when the release is
 * deleted, instead of losing the review to the `reviews.album_id` cascade and the pointer to its
 * `ON DELETE SET NULL`:
 *
 *   1. an unfiled record that cites the release gets its own review, revisions and print log, and
 *      keeps its state, `accepted_by`, `accepted_at`; every column of the copy equals the original's
 *      except `id`, `intake_item_id` and `album_id`;
 *   2. a record filed as another release is stamped with that release and keeps `filed`; that
 *      release's release-level print rows follow the copy;
 *   3. two records that accepted the same review each get their own copy;
 *   4. nothing is copied for a record filed as the deleted release, a record that accepted one of its
 *      own reviews, a record with no accepted review, or a review no record accepted;
 *   5. after the batch is restored, the original review is back with its revisions, the record still
 *      points at its copy and its citation is still NULL, with no deviation reported.
 *
 * Rows come from `tests/utils/intake_seed.js`. Reviewer names are placeholders.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedAuthUser,
  removeSeededAuthUsers,
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewRevision,
  seedReviewPrint,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('DELETE /library/:id copies the cover review a record took from the release (BS#2875)', () => {
  let auth;
  let sql;
  let reviewer;
  let manager;
  const marker = `BS#2875 ${Date.now()}`;
  const releaseIds = [];
  const itemIds = [];

  const seedRelease = async (overrides = {}) => {
    const release = await seedLibraryRelease(overrides);
    releaseIds.push(release.id);
    return release;
  };

  const seedItem = async (overrides = {}) => {
    const item = await seedIntakeItem({
      state: 'reviewed',
      accepted_by: manager.id,
      accepted_at: '2025-03-06T01:02:03.456789+00:00',
      ...overrides,
    });
    itemIds.push(item.id);
    return item;
  };

  /**
   * A review of `releaseId` with every column off its default (the consent columns and `credit`
   * included, and microsecond timestamps), and two revisions with their own editors and times.
   */
  const seedCoverReview = async (releaseId, label = 'cover') => {
    const review = await seedReview({
      album_id: releaseId,
      review: `${marker} ${label}`,
      author: 'Test Reviewer',
      author_user_id: reviewer.id,
      recorded_by_user_id: manager.id,
      medium: 'typed',
      artist_blurb: 'A blurb about the artist.',
      buzzwords: 'hushed, rural',
      recommended_tracks: 'la paradoja',
      fcc: 'Track 3 has a word to watch.',
      status: 'submitted',
      submitted_at: '2025-03-04T05:06:07.123456+00:00',
      add_date: '2025-03-04',
      last_modified: '2025-03-05T06:07:08.654321+00:00',
      publish_website: true,
      publish_apps: true,
      publish_instagram: true,
      credit: 'real_name',
    });
    const first = await seedReviewRevision({
      review_id: review.id,
      revision: 1,
      review: 'The first draft.',
      artist_blurb: 'An older blurb.',
      edited_by: 'Test Reviewer',
      edited_by_user_id: reviewer.id,
      edited_at: '2025-03-04T05:06:07.111111+00:00',
    });
    const second = await seedReviewRevision({
      review_id: review.id,
      revision: 2,
      review: `${marker} ${label}`,
      edited_by: 'Test Manager',
      edited_by_user_id: manager.id,
      edited_at: '2025-03-05T06:07:08.222222+00:00',
    });
    return { review, revisions: [first, second] };
  };

  const jsonRows = (query) => query.then((rows) => rows.map((row) => row.j));
  const reviewJson = async (id) =>
    (await jsonRows(sql`SELECT to_jsonb(r) AS j FROM ${sql(SCHEMA)}.reviews r WHERE r.id = ${id}`))[0];
  const revisionsJson = (reviewId) =>
    jsonRows(
      sql`SELECT to_jsonb(v) AS j FROM ${sql(SCHEMA)}.review_revisions v WHERE v.review_id = ${reviewId} ORDER BY v.revision`
    );
  const columnsOf = async (table) =>
    (
      await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${SCHEMA} AND table_name = ${table}`
    ).map((row) => row.column_name);
  const itemRow = async (id) => (await sql`SELECT * FROM ${sql(SCHEMA)}.intake_items WHERE id = ${id}`)[0];

  /** Every column of the table the copy must carry over, walked from the table and not from a list. */
  const expectSameColumns = (columns, original, copy, omitted) => {
    for (const column of columns.filter((name) => !omitted.includes(name))) {
      expect({ column, value: copy[column] }).toEqual({ column, value: original[column] });
    }
  };

  const deleteRelease = async (releaseId) => {
    await auth.delete(`/library/${releaseId}`).expect(204);
    const [{ batch_id }] = await sql`
      SELECT batch_id FROM ${sql(SCHEMA)}.catalog_delete_snapshot
       WHERE entity_kind = 'library' AND entity_id = ${releaseId} ORDER BY id DESC LIMIT 1`;
    return batch_id;
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    reviewer = await seedAuthUser({ name: 'Test Reviewer' });
    manager = await seedAuthUser({ name: 'Test Manager' });
  });

  afterAll(async () => {
    if (itemIds.length > 0) await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE id = ANY(${itemIds})`;
    await removeSeededLibraryReleases();
    if (releaseIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY(${releaseIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_delete_denylist WHERE library_id = ANY(${releaseIds})`;
    }
    await removeSeededAuthUsers();
  });

  test('an unfiled record that cites the release gets its own review, revisions and print log', async () => {
    const cited = await seedRelease();
    const { review, revisions } = await seedCoverReview(cited.id);
    const item = await seedItem({ cited_album_id: cited.id, accepted_review_id: review.id });
    await seedReviewPrint({
      intake_item_id: item.id,
      review_id: review.id,
      revision_id: revisions[0].id,
      printed_by: manager.id,
    });
    const reviewColumns = await columnsOf('reviews');
    const revisionColumns = await columnsOf('review_revisions');
    const original = await reviewJson(review.id);
    const originalRevisions = await revisionsJson(review.id);
    // A column left at its default would make the comparison below prove nothing.
    expect(original).toMatchObject({
      publish_website: true,
      publish_apps: true,
      publish_instagram: true,
      credit: 'real_name',
    });

    await deleteRelease(cited.id);

    const after = await itemRow(item.id);
    expect(after.accepted_review_id).not.toBeNull();
    expect(after.accepted_review_id).not.toBe(review.id);
    expect(after).toMatchObject({
      state: 'reviewed',
      accepted_by: manager.id,
      cited_album_id: null,
      album_id: null,
    });
    expect(after.accepted_at).toEqual(item.accepted_at);
    const copy = await reviewJson(after.accepted_review_id);
    expect(copy).toMatchObject({ intake_item_id: item.id, album_id: null });
    expectSameColumns(reviewColumns, original, copy, ['id', 'intake_item_id', 'album_id']);
    const copiedRevisions = await revisionsJson(copy.id);
    expect(copiedRevisions).toHaveLength(2);
    copiedRevisions.forEach((revision, index) => {
      expect(revision.review_id).toBe(copy.id);
      expectSameColumns(revisionColumns, originalRevisions[index], revision, ['id', 'review_id']);
    });
    const prints = await sql`SELECT * FROM ${sql(SCHEMA)}.review_prints WHERE intake_item_id = ${item.id}`;
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ review_id: copy.id, revision_id: copiedRevisions[0].id });
  });

  test('a record filed as another release is stamped with it, stays filed, and its release-level prints follow the copy', async () => {
    const cited = await seedRelease();
    const filedAs = await seedRelease({ album_title: 'Edits', artist_name: 'Chuquimamani-Condori' });
    const { review, revisions } = await seedCoverReview(cited.id);
    const item = await seedItem({
      state: 'filed',
      album_id: filedAs.id,
      cited_album_id: cited.id,
      accepted_review_id: review.id,
    });
    const releaseLevel = await seedReviewPrint({
      album_id: filedAs.id,
      review_id: review.id,
      revision_id: revisions[1].id,
      printed_by: manager.id,
    });

    await deleteRelease(cited.id);

    const after = await itemRow(item.id);
    expect(after).toMatchObject({ state: 'filed', album_id: filedAs.id, cited_album_id: null });
    const copy = await reviewJson(after.accepted_review_id);
    expect(copy).toMatchObject({ intake_item_id: item.id, album_id: filedAs.id });
    const copiedRevisions = await revisionsJson(copy.id);
    const [print] = await sql`SELECT * FROM ${sql(SCHEMA)}.review_prints WHERE id = ${releaseLevel.id}`;
    expect(print).toMatchObject({ album_id: filedAs.id, intake_item_id: null, review_id: copy.id });
    expect(print.revision_id).toBe(copiedRevisions[1].id);
  });

  test('two records that accepted the same review each get their own copy', async () => {
    const cited = await seedRelease();
    const { review } = await seedCoverReview(cited.id);
    const first = await seedItem({ cited_album_id: cited.id, accepted_review_id: review.id });
    const second = await seedItem({ cited_album_id: cited.id, accepted_review_id: review.id });

    await deleteRelease(cited.id);

    const [a, b] = await Promise.all([itemRow(first.id), itemRow(second.id)]);
    expect(new Set([a.accepted_review_id, b.accepted_review_id, review.id]).size).toBe(3);
    for (const [item, row] of [
      [first, a],
      [second, b],
    ]) {
      const copy = await reviewJson(row.accepted_review_id);
      expect(copy.intake_item_id).toBe(item.id);
      expect(await revisionsJson(copy.id)).toHaveLength(2);
    }
  });

  test('nothing is copied for a record filed as the release, one with its own accepted review, one with none, or a review nobody accepted', async () => {
    const cited = await seedRelease();
    const filedAsCited = await seedItem({ state: 'filed', album_id: cited.id });
    const { review: acceptedByFiledAsCited } = await seedCoverReview(cited.id, 'nc-filed-as-release');
    const nobodyAccepted = await seedCoverReview(cited.id, 'nc-nobody-accepted');
    await sql`UPDATE ${sql(SCHEMA)}.intake_items SET accepted_review_id = ${acceptedByFiledAsCited.id} WHERE id = ${filedAsCited.id}`;
    const ownReviewer = await seedItem({ cited_album_id: cited.id });
    const own = await seedReview({
      intake_item_id: ownReviewer.id,
      review: `${marker} nc-own`,
      author: 'Test Reviewer',
    });
    await sql`UPDATE ${sql(SCHEMA)}.intake_items SET accepted_review_id = ${own.id} WHERE id = ${ownReviewer.id}`;
    const noAccepted = await seedItem({
      state: 'checked_out',
      cited_album_id: cited.id,
      accepted_by: null,
      accepted_at: null,
    });
    const before =
      await sql`SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.reviews WHERE review LIKE ${`${marker} nc-%`}`;
    // The record filed as the release has no review of its own; its accepted review is one of the release's.
    expect(before[0].n).toBe(3);

    const batchId = await deleteRelease(cited.id);

    // A copy made wrongly for the record filed as the release would carry that record's id and the
    // release's id, so the cascade removes it with the release and no row check afterwards can see it.
    // The delete's snapshot is taken after the copy step, so it is where a wrong copy would show: it
    // holds exactly the release's two original reviews.
    const [{ captured }] = await sql`
      SELECT captured->'children'->'reviews' AS captured FROM ${sql(SCHEMA)}.catalog_delete_snapshot
       WHERE batch_id = ${batchId} AND entity_kind = 'library' AND entity_id = ${cited.id}`;
    expect(captured.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [acceptedByFiledAsCited.id, nobodyAccepted.review.id].sort((a, b) => a - b)
    );
    expect(captured.filter((row) => row.intake_item_id === filedAsCited.id)).toEqual([]);

    // Only the record's own review is left: the other two went with the release.
    const left = await sql`SELECT id, review FROM ${sql(SCHEMA)}.reviews WHERE review LIKE ${`${marker} nc-%`}`;
    expect(left).toEqual([{ id: own.id, review: `${marker} nc-own` }]);
    expect((await itemRow(ownReviewer.id)).accepted_review_id).toBe(own.id);
    expect((await itemRow(noAccepted.id)).accepted_review_id).toBeNull();
    const reviewsOfItems = await sql`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.reviews WHERE intake_item_id = ANY(${[ownReviewer.id, noAccepted.id]})`;
    expect(reviewsOfItems[0].n).toBe(1);
  });

  test('after the batch is restored the original review is back with its history, and the record still points at its copy', async () => {
    const cited = await seedRelease();
    const { review, revisions } = await seedCoverReview(cited.id);
    const item = await seedItem({ cited_album_id: cited.id, accepted_review_id: review.id });
    const batchId = await deleteRelease(cited.id);
    const copyId = (await itemRow(item.id)).accepted_review_id;
    expect(copyId).not.toBe(review.id);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].deviations).toEqual([]);
    const restored = await reviewJson(review.id);
    expect(restored).toMatchObject({ id: review.id, album_id: cited.id, review: `${marker} cover` });
    expect((await revisionsJson(review.id)).map((revision) => revision.id)).toEqual(
      revisions.map((revision) => revision.id)
    );
    const after = await itemRow(item.id);
    expect(after.accepted_review_id).toBe(copyId);
    expect(after.cited_album_id).toBeNull();
    expect(await reviewJson(copyId)).toMatchObject({ intake_item_id: item.id, album_id: null });
  });
});
