/**
 * Drives each after-commit review notice through HTTP once (BS#3109), as seeded real accounts.
 *
 * The notices (`apps/backend/services/review-notices.service.ts`) start after the commit and are not awaited, so the
 * response is 200 whether or not their lookups work. These tests assert only the HTTP outcome; the guard step after
 * "Run Integration Tests" in `.github/workflows/test.yml` fails the job when `/tmp/backend.log` carries the
 * `[review-notices] Failed to send a review notice:` prefix. That catches only failures that reach `reportFailure`
 * (`musicDirectorEmails`, `notifyAccount`'s account read, `notifyDigitalTaken`'s taker lookup). `notifyPass`'s own name
 * read is wrapped in `.catch(() => null)`: a failure there writes no line and the notice goes out as 'A DJ', so the
 * guard does not see it; its SQL is covered by the in-transaction `readStaffName` read on the PATCH test below, whose
 * 200 fails on a broken read. The guard runs in CI only: the local `ci:testmock` stack keeps its logs in Docker. The CI containers run AUTH_BYPASS=true, so a raw
 * user-id Bearer acts as that account (it must exist in `auth_user`: a taker with no account is reported on purpose).
 *
 * Triggers: `notifyDigitalTaken` (checkout, and accepting a request), `notifyPass` (its `musicDirectorEmails` read and
 * the send), `notifyAccount` (a music director edits a DJ's submitted review) and `musicDirectorEmails` (every one of
 * them, via a seeded music director).
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const {
  seedAuthUser,
  seedMember,
  removeSeededAuthUsers,
  seedIntakeItem,
  removeSeededIntakeItems,
  seedReview,
  managerAccessToken,
} = require('../utils/intake_seed');

const PREFIX = 'ITEST-NOTICES';

describe('review notices driven through HTTP (BS#3109)', () => {
  let manager;
  let taker;
  let author;

  const seedUser = async (key, role, overrides = {}) => {
    const user = await seedAuthUser({ name: `${PREFIX} ${key}`, ...overrides });
    await seedMember(user.id, role);
    return user;
  };
  const asUser = (user) => createAuthRequest(request, `Bearer ${user.id}`);
  const digital = (key, overrides = {}) =>
    seedIntakeItem({
      artist_name: `${PREFIX} ${key}`,
      album_title: `Album ${key}`,
      digital: true,
      ...overrides,
    });

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    // A music director to receive each notice (so `musicDirectorEmails` has a row to read), a DJ to take and pass, and a DJ whose review is edited.
    await seedUser('director', 'musicDirector');
    taker = await seedUser('taker', 'dj');
    author = await seedUser('author', 'dj');
  });

  afterAll(async () => {
    await removeSeededIntakeItems();
    await removeSeededAuthUsers();
  });

  test('notifyDigitalTaken: a DJ checks out a digital album', async () => {
    const item = await digital('checkout');
    const res = await asUser(taker).post(`/intake/${item.id}/checkout`).send({});
    expect([res.status, res.body.state]).toEqual([200, 'checked_out']);
  });

  test('notifyDigitalTaken: a DJ accepts a request for a digital album', async () => {
    const item = await digital('accept', {
      state: 'requested',
      requested_dj_id: taker.id,
      requested_at: new Date().toISOString(),
    });
    const res = await asUser(taker).post(`/intake/${item.id}/accept`).send({});
    expect([res.status, res.body.state]).toEqual([200, 'checked_out']);
  });

  test('notifyPass: a DJ passes on a request', async () => {
    const item = await digital('pass', {
      state: 'requested',
      requested_dj_id: taker.id,
      requested_at: new Date().toISOString(),
    });
    const res = await asUser(taker).post(`/intake/${item.id}/pass`).send({});
    expect(res.status).toBe(200);
  });

  test("notifyAccount: a music director edits a DJ's submitted review", async () => {
    const item = await digital('edit');
    const review = await seedReview({
      intake_item_id: item.id,
      author: `${PREFIX} author`,
      author_user_id: author.id,
    });
    const res = await manager.patch(`/reviews/${review.id}`).send({ review: 'Edited by a music director.' });
    expect([res.status, res.body.review]).toEqual([200, 'Edited by a music director.']);
  });
});
