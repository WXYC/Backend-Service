/**
 * `POST /intake/{id}/accept-review` and the pieces that ship with it (BS#2860, slice 10d of BS#2791): the
 * awaiting-acceptance queue, the new `IntakeItem` fields, returning a reviewed record, the citation-change PATCH,
 * and the holder of a reviewed record starting a review. Real Postgres, seeded through tests/utils/intake_seed.js.
 * As in intake-transitions.spec.js, the CI containers run AUTH_BYPASS=true, so the route grants are pinned by
 * tests/unit/routes/intake-accept-review.route.test.ts; `djA` is a raw user-id Bearer acting as a non-manager.
 * What this tier pins is the SQL against real rows, including the lock order against a concurrent delete.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedFormSubmission,
  removeSeededFormSubmissions,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-ACCEPT-REVIEW';
const REFUSAL = 'review_id must name a submitted review of this record';

describe('/intake accept-review (BS#2860)', () => {
  let manager;
  let managerId;
  let djA;
  let djB;
  let sql;
  let releaseId;

  const now = () => new Date().toISOString();
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const item = (key, overrides = {}) => seedIntakeItem({ artist_name: `${PREFIX} ${key}`, ...overrides });
  const held = (key, overrides = {}) =>
    item(key, { state: 'checked_out', checked_out_by: global.primary_dj_id, checked_out_at: now(), ...overrides });
  const reviewOn = (target, overrides = {}) =>
    seedReview({ ...target, author: `${PREFIX} author`, author_user_id: global.primary_dj_id, ...overrides });
  const accept = (id, review_id) => manager.post(`/intake/${id}/accept-review`).send({ review_id });
  const itemRow = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]))[0];
  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    const [managerRow] = await sql`SELECT id FROM auth_user WHERE username = 'test_station_manager'`;
    if (!managerRow) throw new Error('test_station_manager fixture account is missing');
    managerId = managerRow.id;
    await cleanup();
    releaseId = (await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` })).id;
  });

  afterAll(cleanup);

  describe('accept', () => {
    test('a pool item takes its own submitted review: reviewed, the pointer and the caller stamped', async () => {
      const pooled = await item('pool');
      const review = await reviewOn({ intake_item_id: pooled.id });
      const res = await accept(pooled.id, review.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        state: 'reviewed',
        accepted_review_id: review.id,
        accepted_by: managerId,
        submitted_review_count: 1,
        overdue: false,
      });
      expect(res.body.accepted_at).not.toBeNull();
    });

    test('the holder stays on a reviewed item, and a pending request is withdrawn', async () => {
      const requested = await item('requested', {
        state: 'requested',
        requested_dj_id: global.secondary_dj_id,
        requested_at: now(),
      });
      const review = await reviewOn({ intake_item_id: requested.id });
      expect((await accept(requested.id, review.id)).status).toBe(200);
      const after = await itemRow(requested.id);
      expect([after.state, after.requested_dj_id, after.requested_at]).toEqual(['reviewed', null, null]);

      const out = await held('out');
      const outReview = await reviewOn({ intake_item_id: out.id });
      await accept(out.id, outReview.id);
      const kept = await itemRow(out.id);
      expect([kept.state, kept.checked_out_by]).toEqual(['reviewed', global.primary_dj_id]);
      expect(kept.checked_out_at).not.toBeNull();
    });

    test('accepting again swaps the pointer and leaves the state', async () => {
      const pooled = await item('swap');
      const first = await reviewOn({ intake_item_id: pooled.id });
      const second = await reviewOn({ intake_item_id: pooled.id });
      await accept(pooled.id, first.id);
      const res = await accept(pooled.id, second.id);
      expect([res.status, res.body.state, res.body.accepted_review_id]).toEqual([200, 'reviewed', second.id]);
    });

    test('a draft, an unknown id and another record’s review answer one 400 and write nothing', async () => {
      const mine = await item('mine');
      const other = await item('other');
      const draft = await reviewOn({ intake_item_id: mine.id }, { status: 'draft', submitted_at: null });
      const theirs = await reviewOn({ intake_item_id: other.id });
      for (const review_id of [draft.id, 2147483647, theirs.id]) {
        const res = await accept(mine.id, review_id);
        expect([res.status, res.body.message]).toEqual([400, REFUSAL]);
      }
      expect((await itemRow(mine.id)).state).toBe('pool');
      expect((await manager.post('/intake/2147483647/accept-review').send({ review_id: 1 })).status).toBe(404);
    });

    test('a library-release review is accepted by an item filed as that release, and by no unfiled item', async () => {
      const review = await reviewOn({ album_id: releaseId }, { medium: 'handwritten' });
      const filed = await item('filed', { state: 'filed', album_id: releaseId, filed_at: now() });
      expect((await accept(filed.id, review.id)).body).toMatchObject({ state: 'filed', accepted_review_id: review.id });
      const unfiled = await item('unfiled');
      expect((await accept(unfiled.id, review.id)).status).toBe(400);
    });

    test('through a citation a typed review of the cited release is accepted, a handwritten one is not', async () => {
      const cited = await item('cited', { cited_album_id: releaseId });
      const typed = await reviewOn({ album_id: releaseId });
      const handwritten = await reviewOn({ album_id: releaseId }, { medium: 'handwritten' });
      expect((await accept(cited.id, handwritten.id)).status).toBe(400);
      expect((await accept(cited.id, typed.id)).body).toMatchObject({
        state: 'reviewed',
        accepted_review_id: typed.id,
      });
    });
  });

  describe('PATCH /intake/{id} citation change', () => {
    const acceptedThroughCitation = async (key) => {
      const cited = await held(key, { cited_album_id: releaseId });
      const typed = await reviewOn({ album_id: releaseId });
      await accept(cited.id, typed.id);
      return cited;
    };

    test.each([
      ['clearing the citation', 'clear', () => ({ cited_album_id: null })],
      ['citing a submission instead', 'switch', async () => ({ cited_submission_id: (await seedFormSubmission()).id })],
    ])('%s takes the accepted review off and returns the item to its holder', async (_name, key, makePatch) => {
      const cited = await acceptedThroughCitation(`patch-${key}`);
      const res = await manager.patch(`/intake/${cited.id}`).send(await makePatch());
      expect(res.status).toBe(200);
      const after = await itemRow(cited.id);
      expect([after.state, after.accepted_review_id, after.accepted_by, after.accepted_at]).toEqual([
        'checked_out',
        null,
        null,
        null,
      ]);
      expect(after.checked_out_by).toBe(global.primary_dj_id);
    });

    test('a patch that leaves the citation, or an accepted review that is the item’s own, is left alone', async () => {
      const cited = await acceptedThroughCitation('patch-title');
      await manager.patch(`/intake/${cited.id}`).send({ album_title: `${PREFIX} renamed` });
      expect((await itemRow(cited.id)).state).toBe('reviewed');

      const own = await held('own', { cited_album_id: releaseId });
      const review = await reviewOn({ intake_item_id: own.id });
      await accept(own.id, review.id);
      await manager.patch(`/intake/${own.id}`).send({ cited_album_id: null });
      expect((await itemRow(own.id)).accepted_review_id).toBe(review.id);
    });
  });

  describe('release of a reviewed record', () => {
    test('check out, submit, accept, then release as the holder: reviewed with no holder', async () => {
      const out = await held('release');
      const draft = await djA.post('/reviews').send({ intake_item_id: out.id, review: 'Lovely.' });
      expect(draft.status).toBe(200);
      expect((await djA.post(`/reviews/${draft.body.id}/submit`)).status).toBe(200);
      expect((await accept(out.id, draft.body.id)).status).toBe(200);
      const res = await djA.post(`/intake/${out.id}/release`);
      expect(res.status).toBe(200);
      const after = await itemRow(out.id);
      expect([after.state, after.checked_out_by, after.checked_out_at, after.accepted_review_id]).toEqual([
        'reviewed',
        null,
        null,
        draft.body.id,
      ]);
      const again = await djA.post(`/intake/${out.id}/release`);
      expect([again.status, again.body.reason]).toEqual([409, 'state_changed']);
    });

    test('another DJ is refused, and a reviewed record whose holder account is gone is for a music director only', async () => {
      const out = await held('release-guard');
      await accept(out.id, (await reviewOn({ intake_item_id: out.id })).id);
      expect((await djB.post(`/intake/${out.id}/release`)).status).toBe(403);

      const gone = await item('release-gone', { checked_out_by: null, checked_out_at: daysAgo(3) });
      await accept(gone.id, (await reviewOn({ intake_item_id: gone.id })).id);
      expect((await djA.post(`/intake/${gone.id}/release`)).status).toBe(403);
      expect((await manager.post(`/intake/${gone.id}/release`)).status).toBe(200);
      expect((await itemRow(gone.id)).state).toBe('reviewed');
    });

    test('a filed item is still 409', async () => {
      const filed = await item('release-filed', { state: 'filed', album_id: releaseId, filed_at: now() });
      expect((await manager.post(`/intake/${filed.id}/release`)).status).toBe(409);
      expect((await itemRow(filed.id)).state).toBe('filed');
    });
  });

  describe('POST /reviews on a reviewed record', () => {
    test('the holder may still start a review; anyone else, and a reviewed record nobody holds, are 409', async () => {
      const out = await held('create');
      const typedUp = await reviewOn({ intake_item_id: out.id }, { medium: 'handwritten', author_user_id: managerId });
      await accept(out.id, typedUp.id);
      const res = await djA.post('/reviews').send({ intake_item_id: out.id, review: 'Mine.' });
      expect([res.status, res.body.status]).toEqual([200, 'draft']);
      const after = await itemRow(out.id);
      expect([after.state, after.checked_out_by, after.accepted_review_id]).toEqual([
        'reviewed',
        global.primary_dj_id,
        typedUp.id,
      ]);
      expect((await djB.post('/reviews').send({ intake_item_id: out.id })).body.reason).toBe('subject_not_held');

      const nobody = await item('create-nobody', { state: 'reviewed' });
      expect((await djA.post('/reviews').send({ intake_item_id: nobody.id })).body.reason).toBe('subject_not_held');
    });
  });

  describe('the queue and the new fields', () => {
    test('awaiting_acceptance lists items with a submitted review and no accepted one, and nothing else', async () => {
      const waiting = await item('waiting');
      await reviewOn({ intake_item_id: waiting.id });
      const draftOnly = await item('draft-only');
      await reviewOn({ intake_item_id: draftOnly.id }, { status: 'draft', submitted_at: null });
      const accepted = await item('accepted');
      await accept(accepted.id, (await reviewOn({ intake_item_id: accepted.id })).id);
      const filed = await item('queue-filed', { state: 'filed', album_id: releaseId, filed_at: now() });
      await reviewOn({ intake_item_id: filed.id });

      const res = await manager.get('/intake').query({ awaiting_acceptance: 'true' });
      const ids = res.body.map((row) => row.id);
      expect(ids).toContain(waiting.id);
      for (const excluded of [draftOnly.id, accepted.id, filed.id]) expect(ids).not.toContain(excluded);
      expect(res.body.find((row) => row.id === waiting.id).submitted_review_count).toBe(1);
      expect((await manager.get('/intake').query({ awaiting_acceptance: 'maybe' })).status).toBe(400);
    });

    test('draft_authors is for a music director only, and equals the draft authors the delete reports, in order', async () => {
      const doomed = await item('doomed');
      await reviewOn(
        { intake_item_id: doomed.id },
        { author: `${PREFIX} Test Reviewer`, status: 'draft', submitted_at: null }
      );
      await reviewOn({ intake_item_id: doomed.id }, { author: `${PREFIX} Submitted Author` });
      await reviewOn(
        { intake_item_id: doomed.id },
        { author: `${PREFIX} Test Visiting DJ`, status: 'draft', submitted_at: null }
      );
      const seen = await manager.get(`/intake/${doomed.id}`);
      expect(seen.body.draft_authors).toEqual([`${PREFIX} Test Reviewer`, `${PREFIX} Test Visiting DJ`]);
      expect((await djA.get(`/intake/${doomed.id}`)).body).not.toHaveProperty('draft_authors');
      const deleted = await manager.delete(`/intake/${doomed.id}`);
      expect(deleted.body.deleted_review_authors).toEqual([
        ...seen.body.draft_authors.slice(0, 1),
        `${PREFIX} Submitted Author`,
        ...seen.body.draft_authors.slice(1),
      ]);
    });

    test('an item whose checkout is over 14 days old is overdue, reviewed or not, and a pool item never is', async () => {
      const late = await held('late', { checked_out_at: daysAgo(20) });
      await accept(late.id, (await reviewOn({ intake_item_id: late.id })).id);
      const res = await manager.get(`/intake/${late.id}`);
      expect([res.body.state, res.body.overdue]).toEqual(['reviewed', true]);
      await manager.post(`/intake/${late.id}/release`);
      expect((await manager.get(`/intake/${late.id}`)).body.overdue).toBe(false);
      const pooled = await manager.get('/intake').query({ state: 'pool' });
      expect(pooled.body.filter((row) => row.artist_name.startsWith(PREFIX) && row.overdue)).toEqual([]);
    });
  });

  describe('against a concurrent delete of the review', () => {
    test('never leaves an item whose accepted_review_id names a missing review', async () => {
      const target = await item('race');
      const review = await reviewOn({ intake_item_id: target.id });
      const [acceptRes, deleteRes] = await Promise.all([
        accept(target.id, review.id),
        manager.delete(`/reviews/${review.id}`),
      ]);
      // A music director's delete of an unfiled item's accepted review is allowed (it takes the review off), so the
      // review is gone either way; the accept either landed first (200, then released) or found it gone (400).
      expect(deleteRes.status).toBe(204);
      expect([200, 400]).toContain(acceptRes.status);
      const after = await itemRow(target.id);
      expect(after.accepted_review_id).toBeNull();
      expect([after.accepted_by, after.accepted_at]).toEqual([null, null]);
      expect(after.state).toBe('pool');
    });
  });
});
