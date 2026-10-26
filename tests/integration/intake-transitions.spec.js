/**
 * `/intake/{id}` transitions: checkout, release, request, cancel-request,
 * accept, pass (BS#2798, slice 8 of BS#2791). Real Postgres, direct SQL seeds.
 *
 * A separate file from intake-items.spec.js on purpose. As there, the CI
 * containers run AUTH_BYPASS=true, so the ROUTE grants are pinned by
 * tests/unit/routes/intake-transitions.route.test.ts; what this tier pins is
 * the SQL: that the effective-state precondition and the identity condition are
 * part of the UPDATE, so two racing DJs cannot both win.
 *
 * Callers: `manager` is test_station_manager's JWT (role claim holds
 * reviews: manage); `djA` / `djB` are raw user-id Bearers that AUTH_BYPASS
 * accepts without a role claim, so they act as non-manager callers with those ids.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  seedReview,
  removeSeededLibraryReleases,
  managerAccessToken,
  managerUserId,
  seedAuthUser,
  seedMember,
  removeSeededAuthUsers,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-INTAKE-TX';
const MEMBER_ID = 'test-member-id-00000000000000001';
const AUTO_DJ_ID = 'itest-intake-tx-autodj';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('/intake transitions (BS#2798)', () => {
  let manager;
  let djA;
  let djB;
  let sql;
  let formatId;
  let libraryId;

  const seed = async (key, overrides = {}) => {
    const row = {
      artist_name: `${PREFIX} ${key}`,
      album_title: `Album ${key}`,
      ...(!overrides.digital && { format_id: formatId }),
      ...overrides,
    };
    return (await seedIntakeItem(row)).id;
  };
  const row = async (id) => (await sql`SELECT * FROM ${sql(SCHEMA)}.intake_items WHERE id = ${id}`)[0];
  const passes = (id) => sql`SELECT dj_id FROM ${sql(SCHEMA)}.intake_item_passes WHERE intake_item_id = ${id}`;
  const post = (who, id, action, body) => who.post(`/intake/${id}/${action}`).send(body ?? {});

  const cleanup = async () => {
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    await cleanup();
    [{ id: formatId }] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);

    // The auto-DJ service account (BS#3076): the dj role grants `reviews: write`, so only its username, the literal
    // reviews-reviewers.spec.js seeds too (that spec and this one must not run in parallel: the username is unique), keeps it
    // from being asked to review. Written as the literal on purpose: the shared constant lives behind the
    // authentication barrel, which this tier cannot load, and the literal pins the stored value's case.
    const autoDj = await seedAuthUser({ id: AUTO_DJ_ID, name: 'Auto DJ', username: 'autodj' });
    await seedMember(autoDj.id, 'dj');

    libraryId = (await seedLibraryRelease({ album_title: `${PREFIX} filed`, artist_name: PREFIX, format_id: formatId }))
      .id;
  });

  afterAll(async () => {
    await removeSeededAuthUsers();
    await cleanup();
  });

  describe('checkout', () => {
    test('two concurrent checkouts of one pooled item: exactly one wins, the other is 409 state_changed', async () => {
      const id = await seed('race');
      const [a, b] = await Promise.all([post(djA, id, 'checkout'), post(djB, id, 'checkout')]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const [winner, loser] = a.status === 200 ? [a, b] : [b, a];
      expect(loser.body.reason).toBe('state_changed');
      expect(winner.body.state).toBe('checked_out');
      const after = await row(id);
      expect(after.checked_out_by).toBe(winner.body.checked_out_by);
      expect(after.checked_out_at).not.toBeNull();
    });

    test('an expired request is effectively pool: checkout succeeds and clears the stale request fields', async () => {
      const id = await seed('expired', {
        state: 'requested',
        requested_dj_id: MEMBER_ID,
        requested_at: daysAgo(8),
      });
      const res = await post(djA, id, 'checkout');
      expect(res.status).toBe(200);
      const after = await row(id);
      expect([after.state, after.requested_dj_id, after.requested_at]).toEqual(['checked_out', null, null]);
    });

    test('checkout clears the asking account of a lapsed request', async () => {
      const id = await seed('expired-asker', {
        state: 'requested',
        requested_dj_id: MEMBER_ID,
        requested_by: global.secondary_dj_id,
        requested_at: daysAgo(8),
      });
      expect((await post(djA, id, 'checkout')).status).toBe(200);
      expect((await row(id)).requested_by).toBeNull();
    });

    test('a live request is not pool: checkout is 409', async () => {
      const id = await seed('live', {
        state: 'requested',
        requested_dj_id: global.secondary_dj_id,
        requested_at: daysAgo(1),
      });
      expect((await post(djA, id, 'checkout')).status).toBe(409);
    });

    describe.each([false, true])('a pool item with reviews (digital: %s)', (digital) => {
      test.each([
        ['no review', [], 200],
        ['a draft only', [{ status: 'draft' }], 200],
        ['a submitted review', [{ status: 'submitted' }], 409],
        ['a submitted review that was then deleted', [{ status: 'submitted', deleted: true }], 200],
      ])('%s', async (name, reviews, status) => {
        const id = await seed(`reviews-${digital}-${name}`, { digital });
        for (const { deleted, ...review } of reviews) {
          const { id: reviewId } = await seedReview({ intake_item_id: id, ...review });
          if (deleted) {
            await sql`DELETE FROM ${sql(SCHEMA)}.reviews WHERE id = ${reviewId}`;
          }
        }
        const res = await post(djA, id, 'checkout');
        expect(res.status).toBe(status);
        if (status === 409) {
          expect(res.body.reason).toBe('state_changed');
          expect((await row(id)).state).toBe('pool');
        }
      });
    });

    test('a filed item is 409 state_changed, a missing one 404', async () => {
      const id = await seed('filed', { state: 'filed', album_id: libraryId, filed_at: daysAgo(1) });
      const res = await post(djA, id, 'checkout');
      expect([res.status, res.body.reason]).toEqual([409, 'state_changed']);
      expect((await post(djA, 2147483647, 'checkout')).status).toBe(404);
    });
  });

  describe('release', () => {
    const held = (key) => seed(key, { checkout: { by: global.primary_dj_id, at: daysAgo(20) } });

    test("a DJ cannot release someone else's checkout (403) and nothing changes", async () => {
      const id = await held('not-yours');
      expect((await post(djB, id, 'release')).status).toBe(403);
      expect((await row(id)).checked_out_by).toBe(global.primary_dj_id);
    });

    test('the holder releases an overdue checkout, which clears the holder fields', async () => {
      const id = await held('mine');
      const res = await post(djA, id, 'release');
      expect(res.status).toBe(200);
      const after = await row(id);
      expect([after.state, after.checked_out_by, after.checked_out_at]).toEqual(['pool', null, null]);
    });

    test('reviews: manage releases anyone, including a checkout whose holder account is gone', async () => {
      const id = await seed('orphan', { checkout: { by: null, at: daysAgo(3) } });
      expect((await post(manager, id, 'release')).status).toBe(200);
      const other = await held('manager-releases');
      expect((await post(manager, other, 'release')).status).toBe(200);
    });

    test('a pooled item is 409 for a DJ, not 403', async () => {
      const id = await seed('already-pool');
      expect((await post(djB, id, 'release')).status).toBe(409);
    });
  });

  describe('request / cancel-request', () => {
    test.each([
      ['an unknown account', { dj_id: 'no-such-user' }],
      ['a member account', { dj_id: MEMBER_ID }],
      ['the auto-DJ service account', { dj_id: AUTO_DJ_ID }],
      ['a non-string', { dj_id: 12 }],
      ['nothing', {}],
    ])('dj_id naming %s is 400 and changes nothing', async (_n, body) => {
      const id = await seed('bad-dj');
      expect((await post(manager, id, 'request', body)).status).toBe(400);
      expect((await row(id)).state).toBe('pool');
    });

    test('a DJ is requested, then the manager cancels', async () => {
      const id = await seed('requested');
      const res = await post(manager, id, 'request', { dj_id: global.secondary_dj_id });
      expect(res.status).toBe(200);
      expect(res.body.effective_state).toBe('requested');
      const after = await row(id);
      expect([after.state, after.requested_dj_id]).toEqual(['requested', global.secondary_dj_id]);
      expect(after.requested_at).not.toBeNull();
      expect(after.requested_by).toBe(await managerUserId());

      expect((await post(manager, id, 'request', { dj_id: global.secondary_dj_id })).status).toBe(409);
      expect((await post(manager, id, 'cancel-request')).status).toBe(200);
      const cancelled = await row(id);
      expect([cancelled.state, cancelled.requested_dj_id, cancelled.requested_at]).toEqual(['pool', null, null]);
      expect(cancelled.requested_by).toBeNull();
      expect((await post(manager, id, 'cancel-request')).status).toBe(409);
    });

    // BS#3531: the backend runs REVIEWS_AUDIENCE=staff here (test.yml, dev_env/docker-compose.yml), where a DJ sees reviews
    // only as a music director or above, or with the `reviews_beta` capability. tests/setup/integration.setup.js grants
    // that to test_dj2 (global.secondary_dj_id), which is why the asks above succeed; test_dj1 holds none.
    test('an ask to a DJ who cannot see reviews is 400 asked_dj_cannot_see_feature and changes nothing', async () => {
      const id = await seed('ask-unseeing-dj');
      const res = await post(manager, id, 'request', { dj_id: global.primary_dj_id });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: "This DJ can't see reviews yet. A station manager can add them to the reviews beta in the DJ Roster.",
        code: 'asked_dj_cannot_see_feature',
      });
      const after = await row(id);
      expect([after.state, after.requested_dj_id, after.requested_at, after.requested_by]).toEqual([
        'pool',
        null,
        null,
        null,
      ]);
    });

    test('a DJ who already passed can be requested again', async () => {
      const id = await seed('re-request');
      await post(manager, id, 'request', { dj_id: global.secondary_dj_id });
      await post(djB, id, 'pass');
      expect((await post(manager, id, 'request', { dj_id: global.secondary_dj_id })).status).toBe(200);
    });
  });

  describe('accept / pass', () => {
    const requested = (key, at = daysAgo(1)) =>
      seed(key, {
        state: 'requested',
        requested_dj_id: global.secondary_dj_id,
        requested_by: AUTO_DJ_ID,
        requested_at: at,
      });

    test('the requested DJ accepts: checked out, request fields cleared', async () => {
      const id = await requested('accept');
      const res = await post(djB, id, 'accept');
      expect(res.status).toBe(200);
      const after = await row(id);
      expect([
        after.state,
        after.checked_out_by,
        after.requested_dj_id,
        after.requested_at,
        after.requested_by,
      ]).toEqual(['checked_out', global.secondary_dj_id, null, null, null]);
    });

    test.each(['accept', 'pass'])(
      'another DJ (and the manager) cannot %s, 403, and nothing changes',
      async (action) => {
        const id = await requested(`other-${action}`);
        expect((await post(djA, id, action)).status).toBe(403);
        expect((await post(manager, id, action)).status).toBe(403);
        expect((await row(id)).requested_dj_id).toBe(global.secondary_dj_id);
        expect(await passes(id)).toHaveLength(0);
      }
    );

    test('the requested DJ passes: pooled, request cleared, one pass recorded', async () => {
      const id = await requested('pass');
      expect((await post(djB, id, 'pass')).status).toBe(200);
      const after = await row(id);
      expect([after.state, after.requested_dj_id, after.requested_at, after.requested_by]).toEqual([
        'pool',
        null,
        null,
        null,
      ]);
      expect(await passes(id)).toEqual([{ dj_id: global.secondary_dj_id }]);
    });

    test('an expired request answers 409 state_changed, not 403, and records no pass', async () => {
      const id = await requested('expired', daysAgo(8));
      expect((await post(djB, id, 'accept')).status).toBe(409);
      expect((await post(djB, id, 'pass')).status).toBe(409);
      expect(await passes(id)).toHaveLength(0);
    });

    test('a requested row with a NULL requested_at reads pool and cannot be accepted', async () => {
      const id = await seed('null-stamp', { state: 'requested', requested_dj_id: global.secondary_dj_id });
      expect((await manager.get(`/intake/${id}`)).body.effective_state).toBe('pool');
      const res = await post(djB, id, 'accept');
      expect([res.status, res.body.reason]).toEqual([409, 'state_changed']);
    });
  });

  /**
   * BS#3388: `pass` takes a request from its DJ and a held item from its holder, and a held item with a submitted
   * review from no one (its holder marks the disc returned with `release`). Who is emailed is not visible here
   * (`EMAIL_ENABLED=false`): the controller's decision is pinned in tests/unit/controllers/intake.notices.controller.test.ts.
   */
  describe.each([false, true])('pass (digital: %s)', (digital) => {
    const requestedOf = (dj, at = daysAgo(1)) => ({ state: 'requested', requested_dj_id: dj, requested_at: at });
    const heldBy = (dj) => ({ checkout: { by: dj, at: daysAgo(2) } });
    const draft = { status: 'draft' };
    const submitted = { status: 'submitted' };
    const callers = () => ({ djA, djB, manager });
    // djA holds, djB is asked. Each seed is a function because the DJ ids exist only once the suite's setup has run.
    const asked = () => requestedOf(global.secondary_dj_id);
    const holding = () => heldBy(global.primary_dj_id);
    const CASES = [
      // [name, status, seed, reviews on the item, caller]
      ['a request, passed by its DJ', 200, asked, [], 'djB'],
      // A request can carry a submitted review (`request` has no such guard), and the review blocks only a held item: the
      // requested DJ may pass, and anyone else is refused as for any request.
      ['a request with a submitted review, passed by its DJ', 200, asked, [submitted], 'djB'],
      ['a request with a submitted review, by another DJ', 403, asked, [submitted], 'djA'],
      ['a held item, passed by its holder', 200, holding, [], 'djA'],
      ["a held item with the holder's draft", 200, holding, [draft], 'djA'],
      ['a held item with a submitted review, by its holder', 409, holding, [submitted], 'djA'],
      ['a held item with a submitted review, by another DJ', 409, holding, [submitted], 'djB'],
      ['a held item with a submitted review, by a manager', 409, holding, [submitted], 'manager'],
      ["another DJ's request", 403, asked, [], 'djA'],
      ["a manager passing someone else's request", 403, asked, [], 'manager'],
      ["another DJ's held item", 403, holding, [], 'djB'],
      ["a manager passing someone else's held item", 403, holding, [], 'manager'],
      ['a pool item', 409, () => ({}), [], 'djA'],
      ['a reviewed item with a checkout', 409, () => ({ state: 'reviewed', ...holding() }), [], 'djA'],
      ['a reviewed item with no checkout', 409, () => ({ state: 'reviewed' }), [], 'djA'],
      ['a filed item', 409, () => ({ state: 'filed', album_id: libraryId, filed_at: daysAgo(1) }), [], 'djA'],
      ['a request older than 7 days', 409, () => requestedOf(global.secondary_dj_id, daysAgo(8)), [], 'djB'],
    ];

    test.each(CASES)('%s: %i', async (name, status, overrides, reviews, caller) => {
      const id = await seed(`pass-${digital}-${name}`, { digital, ...overrides() });
      const seededReviews = [];
      for (const review of reviews) {
        const author = review.status === 'draft' ? { author_user_id: global.primary_dj_id } : {};
        seededReviews.push(await seedReview({ intake_item_id: id, ...review, ...author }));
      }
      const before = await row(id);

      const res = await post(callers()[caller], id, 'pass');
      expect(res.status).toBe(status);
      const after = await row(id);

      if (status === 200) {
        expect([
          after.state,
          after.requested_dj_id,
          after.requested_at,
          after.checked_out_by,
          after.checked_out_at,
        ]).toEqual(['pool', null, null, null, null]);
        expect(await passes(id)).toEqual([{ dj_id: caller === 'djA' ? global.primary_dj_id : global.secondary_dj_id }]);
        for (const { id: reviewId, status: reviewStatus } of seededReviews) {
          const kept = (await sql`SELECT status FROM ${sql(SCHEMA)}.reviews WHERE id = ${reviewId}`)[0];
          expect(kept.status).toBe(reviewStatus);
          // Only a draft is the passer's to finish; a submitted review waits for a music director and has no author here.
          if (reviewStatus === 'draft') {
            const edit = await djA.patch(`/reviews/${reviewId}`).send({ review: 'Finished after passing.' });
            expect(edit.status).toBe(200);
          }
        }
      } else {
        if (status === 409) {
          expect(res.body.reason).toBe('state_changed');
        }
        expect(after).toEqual(before);
        expect(await passes(id)).toHaveLength(0);
      }
    });
  });
});
