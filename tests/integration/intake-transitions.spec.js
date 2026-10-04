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

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const getAccessToken = require('../utils/better_auth');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-INTAKE-TX';
const MEMBER_ID = 'test-member-id-000000000000000001';

const makeSql = () =>
  postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 4,
  });

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('/intake transitions (BS#2798)', () => {
  let manager;
  let djA;
  let djB;
  let sql;
  let formatId;
  let libraryId;

  const seed = async (key, overrides = {}) => {
    const row = { artist_name: `${PREFIX} ${key}`, album_title: `Album ${key}`, format_id: formatId, ...overrides };
    const [{ id }] = await sql`INSERT INTO ${sql(SCHEMA)}.intake_items ${sql(row)} RETURNING id`;
    return id;
  };
  const row = async (id) => (await sql`SELECT * FROM ${sql(SCHEMA)}.intake_items WHERE id = ${id}`)[0];
  const passes = (id) => sql`SELECT dj_id FROM ${sql(SCHEMA)}.intake_item_passes WHERE intake_item_id = ${id}`;
  const post = (who, id, action, body) => who.post(`/intake/${id}/${action}`).send(body ?? {});

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title = $1`, [`${PREFIX} filed`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZZ'`, [PREFIX]);
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await getAccessToken('test_station_manager', 'testpassword123')}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = makeSql();
    await cleanup();
    [{ id: formatId }] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);

    const [genre] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".genres ORDER BY id LIMIT 1`);
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters) VALUES ($1, $1, 'ZZ') RETURNING id`,
      [PREFIX]
    );
    const [lib] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 9103, $5) RETURNING id`,
      [artist.id, genre.id, formatId, `${PREFIX} filed`, PREFIX]
    );
    libraryId = lib.id;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
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

    test('a live request is not pool: checkout is 409', async () => {
      const id = await seed('live', {
        state: 'requested',
        requested_dj_id: global.secondary_dj_id,
        requested_at: daysAgo(1),
      });
      expect((await post(djA, id, 'checkout')).status).toBe(409);
    });

    test('a filed item is 409 state_changed, a missing one 404', async () => {
      const id = await seed('filed', { state: 'filed', album_id: libraryId, filed_at: daysAgo(1) });
      const res = await post(djA, id, 'checkout');
      expect([res.status, res.body.reason]).toEqual([409, 'state_changed']);
      expect((await post(djA, 2147483647, 'checkout')).status).toBe(404);
    });
  });

  describe('release', () => {
    const held = (key) =>
      seed(key, { state: 'checked_out', checked_out_by: global.primary_dj_id, checked_out_at: daysAgo(20) });

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
      const id = await seed('orphan', { state: 'checked_out', checked_out_by: null, checked_out_at: daysAgo(3) });
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

      expect((await post(manager, id, 'request', { dj_id: global.secondary_dj_id })).status).toBe(409);
      expect((await post(manager, id, 'cancel-request')).status).toBe(200);
      const cancelled = await row(id);
      expect([cancelled.state, cancelled.requested_dj_id, cancelled.requested_at]).toEqual(['pool', null, null]);
      expect((await post(manager, id, 'cancel-request')).status).toBe(409);
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
      seed(key, { state: 'requested', requested_dj_id: global.secondary_dj_id, requested_at: at });

    test('the requested DJ accepts: checked out, request fields cleared', async () => {
      const id = await requested('accept');
      const res = await post(djB, id, 'accept');
      expect(res.status).toBe(200);
      const after = await row(id);
      expect([after.state, after.checked_out_by, after.requested_dj_id, after.requested_at]).toEqual([
        'checked_out',
        global.secondary_dj_id,
        null,
        null,
      ]);
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
      expect([after.state, after.requested_dj_id, after.requested_at]).toEqual(['pool', null, null]);
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
});
