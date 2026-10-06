/**
 * `POST /reviews/{id}/submit`, `DELETE /reviews/{id}` and the `deleted_review_authors` of `DELETE /intake/{id}`
 * (BS#2854, slice 10b of BS#2791). Real Postgres, seeded through tests/utils/intake_seed.js. As in reviews.spec.js,
 * the CI containers run AUTH_BYPASS=true, so the route grants are pinned by
 * tests/unit/routes/reviews-permissions.route.test.ts and `djA` is a raw user-id Bearer (a non-manager acting as
 * that id). What this tier pins is the SQL: revision 1 written with the status change, the item left alone, the
 * delete table's rows against real rows, and the one UPDATE that takes a review off every item accepting it.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  removeSeededIntakeItems,
  seedAcceptance,
  seedFormSubmission,
  removeSeededFormSubmissions,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewPrint,
  managerAccessToken,
  managerUserId,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-SUBMIT-DELETE';

describe('/reviews submit and delete (BS#2854)', () => {
  let manager;
  let managerId;
  let djA;
  let djB;
  let sql;
  let libraryId;

  const item = async (key, overrides = {}) => seedIntakeItem({ artist_name: `${PREFIX} ${key}`, ...overrides });
  const held = (key, overrides = {}) => item(key, { checkout: { by: global.primary_dj_id }, ...overrides });
  const reviewFor = (target, overrides = {}) =>
    seedReview({ ...target, author: `${PREFIX} author`, author_user_id: global.primary_dj_id, ...overrides });
  /** Marks `review` as the one `itemRow` accepts, as accept (BS#2860) will. */
  const accept = (itemRow, review) =>
    seedAcceptance({ intake_item_id: itemRow, review_id: review.id, accepted_by: managerId });
  const itemRow = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]))[0];
  const reviewRow = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".reviews WHERE id = $1`, [id]))[0];
  const revisions = (id) =>
    sql.unsafe(
      `SELECT revision, review, artist_blurb, edited_by, edited_by_user_id FROM "${SCHEMA}".review_revisions WHERE review_id = $1 ORDER BY revision`,
      [id]
    );
  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    managerId = await managerUserId();
    await cleanup();
    libraryId = (await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` })).id;
  });

  afterAll(cleanup);

  describe('POST /reviews/{id}/submit', () => {
    test('submits the draft, writes revision 1 with it, and leaves the intake item exactly as it was', async () => {
      const held1 = await held('submit');
      const draft = await reviewFor(
        { intake_item_id: held1.id },
        { status: 'draft', submitted_at: null, artist_blurb: 'A blurb.' }
      );
      const res = await djA.post(`/reviews/${draft.id}/submit`);
      expect([res.status, res.body.status]).toEqual([200, 'submitted']);
      expect(res.body.submitted_at).not.toBeNull();
      expect(await revisions(draft.id)).toEqual([
        {
          revision: 1,
          review: draft.review,
          artist_blurb: 'A blurb.',
          edited_by: `${PREFIX} author`,
          edited_by_user_id: global.primary_dj_id,
        },
      ]);
      const after = await itemRow(held1.id);
      expect([after.state, after.checked_out_by, after.accepted_review_id]).toEqual([
        'checked_out',
        global.primary_dj_id,
        null,
      ]);
    });

    test('submitting twice is 409 not_draft and writes no second revision', async () => {
      const draft = await reviewFor({ album_id: libraryId }, { status: 'draft', submitted_at: null });
      expect((await djA.post(`/reviews/${draft.id}/submit`)).status).toBe(200);
      const again = await djA.post(`/reviews/${draft.id}/submit`);
      expect([again.status, again.body.reason]).toEqual([409, 'not_draft']);
      expect(await revisions(draft.id)).toHaveLength(1);
    });

    test('a typed review with no text is 400 and stays a draft; a handwritten one is submitted', async () => {
      const typed = await reviewFor({ album_id: libraryId }, { status: 'draft', submitted_at: null, review: null });
      expect((await djA.post(`/reviews/${typed.id}/submit`)).status).toBe(400);
      expect((await reviewRow(typed.id)).status).toBe('draft');
      expect(await revisions(typed.id)).toEqual([]);
      const handwritten = await reviewFor(
        { album_id: libraryId },
        { status: 'draft', submitted_at: null, review: null, medium: 'handwritten' }
      );
      expect((await djA.post(`/reviews/${handwritten.id}/submit`)).status).toBe(200);
    });

    test('a draft for a filed item is submitted like any other, and the item stays filed', async () => {
      const filed = await item('filed', { state: 'filed', album_id: libraryId });
      const draft = await reviewFor({ intake_item_id: filed.id }, { status: 'draft', submitted_at: null });
      expect((await djA.post(`/reviews/${draft.id}/submit`)).status).toBe(200);
      expect((await itemRow(filed.id)).state).toBe('filed');
    });

    test("another DJ's draft is a 404, a music director's too; the draft is untouched", async () => {
      const draft = await reviewFor({ album_id: libraryId }, { status: 'draft', submitted_at: null });
      expect((await djB.post(`/reviews/${draft.id}/submit`)).status).toBe(404);
      expect((await manager.post(`/reviews/${draft.id}/submit`)).status).toBe(404);
      expect((await reviewRow(draft.id)).status).toBe('draft');
      expect((await djA.post('/reviews/2147483647/submit')).status).toBe(404);
    });
  });

  describe('DELETE /reviews/{id}', () => {
    test('an author deletes their own review that is not in use, and its revisions go with it', async () => {
      const submitted = await reviewFor({ album_id: libraryId });
      await djA.patch(`/reviews/${submitted.id}`).send({ review: 'Edited.' });
      expect((await revisions(submitted.id)).length).toBeGreaterThan(0);
      expect((await djA.delete(`/reviews/${submitted.id}`)).status).toBe(204);
      expect(await reviewRow(submitted.id)).toBeUndefined();
      expect(await revisions(submitted.id)).toEqual([]);
    });

    test('another DJ may not delete a submitted review (403) and cannot see a draft (404); a music director may delete the former', async () => {
      const submitted = await reviewFor({ album_id: libraryId });
      const draft = await reviewFor({ album_id: libraryId }, { status: 'draft', submitted_at: null });
      expect((await djB.delete(`/reviews/${submitted.id}`)).status).toBe(403);
      expect((await djB.delete(`/reviews/${draft.id}`)).status).toBe(404);
      expect((await manager.delete(`/reviews/${draft.id}`)).status).toBe(404);
      expect((await manager.delete(`/reviews/${submitted.id}`)).status).toBe(204);
      expect((await djA.delete('/reviews/2147483647')).status).toBe(404);
    });

    test('an author is refused in_use for an accepted review and for the latest print of a copy, and can delete once a newer print names another review', async () => {
      const accepted = await item('accepted', { state: 'reviewed' });
      const acceptedReview = await reviewFor({ intake_item_id: accepted.id });
      await accept(accepted.id, acceptedReview);
      const refusedAccepted = await djA.delete(`/reviews/${acceptedReview.id}`);
      expect([refusedAccepted.status, refusedAccepted.body.reason]).toEqual([409, 'in_use']);
      expect(await reviewRow(acceptedReview.id)).toBeDefined();

      const printedItem = await item('printed');
      const printedReview = await reviewFor({ intake_item_id: printedItem.id });
      const otherReview = await reviewFor({ intake_item_id: printedItem.id });
      await seedReviewPrint({
        intake_item_id: printedItem.id,
        review_id: printedReview.id,
        printed_at: '2026-09-01T12:00:00Z',
      });
      const refusedPrinted = await djA.delete(`/reviews/${printedReview.id}`);
      expect([refusedPrinted.status, refusedPrinted.body.reason]).toEqual([409, 'in_use']);
      await seedReviewPrint({
        intake_item_id: printedItem.id,
        review_id: otherReview.id,
        printed_at: '2026-09-02T12:00:00Z',
      });
      expect((await djA.delete(`/reviews/${printedReview.id}`)).status).toBe(204);
      expect((await djA.delete(`/reviews/${otherReview.id}`)).status).toBe(409);
    });

    test('a release-level print (no intake item) is in use only while it is the newest print of that release', async () => {
      const older = await reviewFor({ album_id: libraryId });
      const newer = await reviewFor({ album_id: libraryId });
      await seedReviewPrint({ album_id: libraryId, review_id: older.id, printed_at: '2026-09-01T12:00:00Z' });
      expect((await djA.delete(`/reviews/${older.id}`)).status).toBe(409);
      await seedReviewPrint({ album_id: libraryId, review_id: newer.id, printed_at: '2026-09-02T12:00:00Z' });
      expect((await djA.delete(`/reviews/${older.id}`)).status).toBe(204);
    });

    test.each([
      ['held by a DJ', true, 'checked_out'],
      ['held by no one', false, 'pool'],
    ])(
      "a music director's delete of the accepted review of an item %s returns it to %s and clears the accept columns",
      async (_name, hasHolder, expected) => {
        const reviewed = await item('reviewed', {
          state: 'reviewed',
          // A checkout is `checked_out_at` (decision 38), so a held item carries both columns.
          ...(hasHolder && { checkout: { by: global.primary_dj_id } }),
        });
        const review = await reviewFor({ intake_item_id: reviewed.id });
        await accept(reviewed.id, review);
        expect((await manager.delete(`/reviews/${review.id}`)).status).toBe(204);
        const after = await itemRow(reviewed.id);
        expect([after.state, after.accepted_review_id, after.accepted_by, after.accepted_at]).toEqual([
          expected,
          null,
          null,
          null,
        ]);
        expect(await reviewRow(review.id)).toBeUndefined();
      }
    );

    test.each([
      ['no citation', false, false],
      ['a citation of a release', true, false],
      ['a citation of a form review', false, true],
    ])(
      'a music director is refused accepted_review for a filed item with %s, and nothing is written',
      async (name, citesRelease, citesForm) => {
        const submission = citesForm ? await seedFormSubmission({ artist_name: PREFIX }) : null;
        const filed = await item(`filed-accepted-${name}`, {
          state: 'filed',
          album_id: libraryId,
          cited_album_id: citesRelease ? libraryId : null,
          cited_submission_id: submission ? submission.id : null,
        });
        const review = await reviewFor({ album_id: libraryId });
        await accept(filed.id, review);
        const refused = await manager.delete(`/reviews/${review.id}`);
        expect([refused.status, refused.body.reason]).toEqual([409, 'accepted_review']);
        const after = await itemRow(filed.id);
        expect([after.state, after.accepted_review_id]).toEqual(['filed', review.id]);
        expect(await reviewRow(review.id)).toBeDefined();
      }
    );

    test('a music director deletes a printed review that is not accepted', async () => {
      const review = await reviewFor({ album_id: libraryId });
      await seedReviewPrint({ album_id: libraryId, review_id: review.id });
      expect((await manager.delete(`/reviews/${review.id}`)).status).toBe(204);
    });

    test('a review accepted by two items: both unfiled items return to holder or pile; with either filed, the citing one included, nothing is written', async () => {
      const own = await item('two-own', {
        state: 'reviewed',
        checkout: { by: global.primary_dj_id },
      });
      const citing = await item('two-citing', { state: 'reviewed', cited_album_id: libraryId });
      const review = await reviewFor({ intake_item_id: own.id, album_id: libraryId });
      await accept(own.id, review);
      await accept(citing.id, review);
      expect((await manager.delete(`/reviews/${review.id}`)).status).toBe(204);
      const [ownAfter, citingAfter] = [await itemRow(own.id), await itemRow(citing.id)];
      expect([ownAfter.state, ownAfter.accepted_review_id, ownAfter.accepted_by]).toEqual(['checked_out', null, null]);
      expect([citingAfter.state, citingAfter.accepted_review_id, citingAfter.accepted_at]).toEqual([
        'pool',
        null,
        null,
      ]);

      // Either of the two filed, the citing one included, refuses the delete and writes neither item.
      for (const filedItem of ['own', 'citing']) {
        // A filed item must carry an album_id (intake_items_filed_requires_album_ck).
        const own2 = await item(`two-own-${filedItem}`, {
          state: filedItem === 'own' ? 'filed' : 'reviewed',
          ...(filedItem === 'own' && { album_id: libraryId }),
        });
        const citing2 = await item(`two-citing-${filedItem}`, {
          state: filedItem === 'citing' ? 'filed' : 'reviewed',
          ...(filedItem === 'citing' && { album_id: libraryId }),
          cited_album_id: libraryId,
        });
        const review2 = await reviewFor({ intake_item_id: own2.id, album_id: libraryId });
        await accept(own2.id, review2);
        await accept(citing2.id, review2);
        const refused = await manager.delete(`/reviews/${review2.id}`);
        expect([refused.status, refused.body.reason]).toEqual([409, 'accepted_review']);
        expect(await reviewRow(review2.id)).toBeDefined();
        const [own2After, citing2After] = [await itemRow(own2.id), await itemRow(citing2.id)];
        expect([own2After.accepted_review_id, citing2After.accepted_review_id]).toEqual([review2.id, review2.id]);
        expect([own2After.state, citing2After.state]).toEqual(
          filedItem === 'own' ? ['filed', 'reviewed'] : ['reviewed', 'filed']
        );
      }
    });
  });

  describe('DELETE /intake/{id} deleted_review_authors', () => {
    test('names the author of every review the cascade took, drafts included, and the reviews are gone', async () => {
      const doomed = await item('doomed');
      const submitted = await seedReview({ intake_item_id: doomed.id, author: `${PREFIX} Test Reviewer` });
      const draft = await seedReview({
        intake_item_id: doomed.id,
        author: `${PREFIX} Test Visiting DJ`,
        status: 'draft',
        submitted_at: null,
      });
      const res = await manager.delete(`/intake/${doomed.id}`);
      expect([res.status, res.body]).toEqual([
        200,
        { deleted_review_authors: [`${PREFIX} Test Reviewer`, `${PREFIX} Test Visiting DJ`] },
      ]);
      expect(await reviewRow(submitted.id)).toBeUndefined();
      expect(await reviewRow(draft.id)).toBeUndefined();
    });

    test('an item with no reviews answers an empty list; a filed item is still 409 already_filed', async () => {
      const bare = await item('bare');
      expect((await manager.delete(`/intake/${bare.id}`)).body).toEqual({ deleted_review_authors: [] });
      const filed = await item('filed-delete', { state: 'filed', album_id: libraryId });
      const refused = await manager.delete(`/intake/${filed.id}`);
      expect([refused.status, refused.body.reason]).toEqual([409, 'already_filed']);
    });
  });
});
