/**
 * Integration tests for /internal/slack-ban-moderators (BS#2045).
 *
 * Hits the live backend with a real Postgres. Three properties here CANNOT be
 * covered by the unit suite and are the reason this file exists:
 *
 *   1. The advisory lock. Two concurrent PUTs from the same `expectedCurrent`
 *      must produce exactly one 200 and one 409 — never a union of both edits.
 *      A mocked transaction cannot exhibit the READ COMMITTED interleaving the
 *      lock exists to prevent.
 *   2. The differential replace. A save that removes one member must leave the
 *      survivors' `added_at` / `added_by_slack_user_id` untouched — only real
 *      rows carry real audit columns.
 *   3. The `pg_advisory_xact_lock(...::bigint)` bind itself, which only a real
 *      parameter round-trip exercises.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const KEY = process.env.ROM_INTERNAL_KEY || 'test-rom-secret-key';
const ROUTE = '/internal/slack-ban-moderators';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

const U1 = 'UTEST00001';
const U2 = 'UTEST00002';
const U3 = 'UTEST00003';
const ACTOR = 'UTESTADMIN';

describe('/internal/slack-ban-moderators (BS#2045)', () => {
  let sql;
  beforeAll(() => {
    sql = makeSql();
  });

  // The endpoint is whole-set by construction, so any leftover row would
  // invalidate the next test's expectedCurrent. This table is exclusive to
  // this spec in the test database.
  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.slack_ban_moderators`);
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DELETE FROM ${SCHEMA}.slack_ban_moderators`);
      await sql.end();
    }
  });

  const put = (body) => request.put(ROUTE).set('X-Internal-Key', KEY).send(body);
  const get = () => request.get(ROUTE).set('X-Internal-Key', KEY);

  describe('auth', () => {
    test('401 on GET without X-Internal-Key', async () => {
      const res = await request.get(ROUTE);
      expect(res.status).toBe(401);
    });

    test('401 on PUT with the wrong key', async () => {
      const res = await request
        .put(ROUTE)
        .set('X-Internal-Key', 'wrong')
        .send({ slackUserIds: [U1], expectedCurrent: [] });
      expect(res.status).toBe(401);

      const rows = await sql.unsafe(`SELECT 1 FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows).toHaveLength(0);
    });
  });

  describe('GET', () => {
    test('200 with an empty items array on an empty table (not 404)', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    // Guards the `slack_user_id` tiebreak on the ORDER BY. `added_at` defaults
    // to now() = transaction-start time, so every member added in ONE save
    // shares a single timestamp and the sort is decided entirely by the
    // tiebreak. Without it Postgres returns whatever order it likes, and the
    // modal's `initial_users` flaps between renders of an unchanged roster.
    //
    // The rows are seeded by direct SQL in DESCENDING id order rather than
    // through a PUT, and that is the whole point: the route normalizes its
    // desired set to sorted order before inserting, so a save always writes
    // rows whose physical order already matches the correct sort. A test that
    // goes through PUT therefore passes with the tiebreak REMOVED — the
    // sequential scan agrees by construction. Only an arrangement where heap
    // order and sort order disagree can observe the tiebreak at all.
    test('orders by slack_user_id when added_at ties, independent of physical row order', async () => {
      const sharedTs = '2026-01-01T00:00:00Z';
      await sql.unsafe(
        `INSERT INTO ${SCHEMA}.slack_ban_moderators (slack_user_id, added_at)
         VALUES ($1, $4::timestamptz), ($2, $4::timestamptz), ($3, $4::timestamptz)`,
        [U3, U2, U1, sharedTs]
      );

      // Precondition: the tiebreak only matters because the timestamps collide.
      const distinct = await sql.unsafe(
        `SELECT COUNT(DISTINCT added_at)::int AS c FROM ${SCHEMA}.slack_ban_moderators`
      );
      expect(distinct[0].c).toBe(1);

      // Repeated because a single call can agree with an unordered scan by luck.
      for (let i = 0; i < 3; i++) {
        const res = await get();
        expect(res.status).toBe(200);
        expect(res.body.items.map((r) => r.slack_user_id)).toEqual([U1, U2, U3]);
      }
    });
  });

  describe('stored-shape invariant', () => {
    // The route's differential replace reads case-insensitively (folding to
    // uppercase before the expectedCurrent comparison) but deletes with plain
    // varchar equality. A row stored in any other case would be folded into a
    // match on read, then miss the DELETE's exclusion list — deleted and
    // reinserted, silently rewriting the audit columns the differential
    // replace exists to preserve. Migration 0141's CHECK makes that row
    // impossible to create rather than merely unlikely.
    test('the database rejects a non-uppercase slack_user_id written outside the route', async () => {
      await expect(
        sql.unsafe(`INSERT INTO ${SCHEMA}.slack_ban_moderators (slack_user_id) VALUES ($1)`, ['u01lowercase'])
      ).rejects.toThrow(/slack_ban_moderators_slack_user_id_upper_ck|violates check constraint/i);

      const rows = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows[0].c).toBe(0);
    });

    test('the database rejects a non-uppercase added_by_slack_user_id', async () => {
      await expect(
        sql.unsafe(
          `INSERT INTO ${SCHEMA}.slack_ban_moderators (slack_user_id, added_by_slack_user_id) VALUES ($1, $2)`,
          [U1, 'uactor']
        )
      ).rejects.toThrow(/slack_ban_moderators_added_by_upper_ck|violates check constraint/i);
    });

    test('a NULL added_by_slack_user_id is still allowed', async () => {
      const res = await put({ slackUserIds: [U1], expectedCurrent: [] });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(
        `SELECT added_by_slack_user_id FROM ${SCHEMA}.slack_ban_moderators WHERE slack_user_id = $1`,
        [U1]
      );
      expect(rows[0].added_by_slack_user_id).toBeNull();
    });
  });

  describe('PUT', () => {
    test('replaces the set, and a second identical PUT is a no-op', async () => {
      const first = await put({ slackUserIds: [U1, U2], expectedCurrent: [], actorSlackUserId: ACTOR });
      expect(first.status).toBe(200);
      expect(first.body.items.map((r) => r.slack_user_id).sort()).toEqual([U1, U2]);

      const second = await put({ slackUserIds: [U1, U2], expectedCurrent: [U1, U2], actorSlackUserId: ACTOR });
      expect(second.status).toBe(200);
      expect(second.body.items.map((r) => r.slack_user_id).sort()).toEqual([U1, U2]);

      const rows = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows[0].c).toBe(2);
    });

    test('records the acting Slack user as the audit trail', async () => {
      await put({ slackUserIds: [U1], expectedCurrent: [], actorSlackUserId: ACTOR });
      const rows = await sql.unsafe(
        `SELECT added_by_slack_user_id FROM ${SCHEMA}.slack_ban_moderators WHERE slack_user_id = $1`,
        [U1]
      );
      expect(rows[0].added_by_slack_user_id).toBe(ACTOR);
    });

    test('409 on a stale expectedCurrent, leaving the table untouched', async () => {
      await put({ slackUserIds: [U1, U2], expectedCurrent: [] });

      // Caller read the roster back when it held only U1.
      const res = await put({ slackUserIds: [U3], expectedCurrent: [U1] });
      expect(res.status).toBe(409);
      expect(res.body.current.sort()).toEqual([U1, U2]);

      const rows = await sql.unsafe(`SELECT slack_user_id FROM ${SCHEMA}.slack_ban_moderators ORDER BY slack_user_id`);
      expect(rows.map((r) => r.slack_user_id)).toEqual([U1, U2]);
    });

    test('duplicate ids in the request collapse to one row', async () => {
      const res = await put({ slackUserIds: [U1, U1, U1.toLowerCase()], expectedCurrent: [] });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows[0].c).toBe(1);
    });

    test('an empty slackUserIds is accepted and empties the table (guarded-insert regression)', async () => {
      await put({ slackUserIds: [U1, U2], expectedCurrent: [] });

      // drizzle's `.values([])` RAISES rather than emitting a no-op, so
      // without the conditional this legal request 500s on the way out.
      const res = await put({ slackUserIds: [], expectedCurrent: [U1, U2] });
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);

      const rows = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows[0].c).toBe(0);
    });

    test('an edit that changes only letter case is not a 409 (normalization regression)', async () => {
      await put({ slackUserIds: [U1], expectedCurrent: [] });

      const res = await put({
        slackUserIds: [U1.toLowerCase()],
        expectedCurrent: [U1.toLowerCase()],
        actorSlackUserId: ACTOR.toLowerCase(),
      });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT slack_user_id FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows.map((r) => r.slack_user_id)).toEqual([U1]);
    });

    test('removing one member leaves the survivors audit columns untouched (differential replace)', async () => {
      await put({ slackUserIds: [U1, U2], expectedCurrent: [], actorSlackUserId: ACTOR });

      const before = await sql.unsafe(
        `SELECT slack_user_id, added_at, added_by_slack_user_id FROM ${SCHEMA}.slack_ban_moderators WHERE slack_user_id = $1`,
        [U1]
      );
      expect(before).toHaveLength(1);

      // A later save by a DIFFERENT actor drops U2. A wholesale DELETE+INSERT
      // would rewrite U1's provenance to this actor and this timestamp.
      const res = await put({ slackUserIds: [U1], expectedCurrent: [U1, U2], actorSlackUserId: U3 });
      expect(res.status).toBe(200);

      const after = await sql.unsafe(
        `SELECT slack_user_id, added_at, added_by_slack_user_id FROM ${SCHEMA}.slack_ban_moderators WHERE slack_user_id = $1`,
        [U1]
      );
      expect(after).toHaveLength(1);
      expect(after[0].added_by_slack_user_id).toBe(ACTOR);
      expect(new Date(after[0].added_at).getTime()).toBe(new Date(before[0].added_at).getTime());
    });

    test.each([
      ['slackUserIds is not an array', { slackUserIds: U1, expectedCurrent: [] }],
      ['a slackUserIds member is not a string', { slackUserIds: [42], expectedCurrent: [] }],
      ['a slackUserIds member has bad characters', { slackUserIds: ['U01-ABC'], expectedCurrent: [] }],
      ['a slackUserIds member is over the length cap', { slackUserIds: ['U'.repeat(65)], expectedCurrent: [] }],
      [
        'slackUserIds is over the 100-entry cap',
        { slackUserIds: Array.from({ length: 101 }, (_, i) => `UCAP${i}`), expectedCurrent: [] },
      ],
      ['expectedCurrent is missing', { slackUserIds: [U1] }],
      ['actorSlackUserId is a non-string', { slackUserIds: [U1], expectedCurrent: [], actorSlackUserId: 42 }],
      [
        'actorSlackUserId is over the length cap',
        { slackUserIds: [U1], expectedCurrent: [], actorSlackUserId: 'U'.repeat(65) },
      ],
    ])('400 when %s, and nothing is written', async (_label, body) => {
      const res = await put(body);
      expect(res.status).toBe(400);

      const rows = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${SCHEMA}.slack_ban_moderators`);
      expect(rows[0].c).toBe(0);
    });
  });

  describe('concurrency', () => {
    // The advisory lock's regression test. Without `pg_advisory_xact_lock`,
    // both transactions read the same live set under READ COMMITTED, both
    // pass the expectedCurrent check, and the second one's DELETE — whose
    // snapshot predates the first commit — cannot see the rows the first
    // inserted. The table then holds the UNION of two edits that each
    // believed they had replaced it, and no 409 ever fires.
    test('two concurrent PUTs from the same expectedCurrent yield one 200 and one 409, never a union', async () => {
      const seed = await put({ slackUserIds: [U1], expectedCurrent: [] });
      expect(seed.status).toBe(200);

      const [a, b] = await Promise.all([
        put({ slackUserIds: [U1, U2], expectedCurrent: [U1], actorSlackUserId: ACTOR }),
        put({ slackUserIds: [U1, U3], expectedCurrent: [U1], actorSlackUserId: ACTOR }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);

      const rows = await sql.unsafe(`SELECT slack_user_id FROM ${SCHEMA}.slack_ban_moderators ORDER BY slack_user_id`);
      const stored = rows.map((r) => r.slack_user_id);
      // Exactly one of the two proposed sets — NOT [U1, U2, U3].
      expect([JSON.stringify([U1, U2]), JSON.stringify([U1, U3])]).toContain(JSON.stringify(stored));
    });
  });
});
