/**
 * Integration tests for /internal/banned-fingerprints CRUD (BS#1261).
 *
 * Hits the live backend with a real Postgres for end-to-end coverage of the
 * three endpoints: POST (create/upsert), DELETE (idempotent), GET (paginated
 * list). Auth gate (X-Internal-Key against ROM_INTERNAL_KEY) is exercised on
 * each method.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const KEY = process.env.ROM_INTERNAL_KEY || 'test-rom-secret-key';

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

const FP1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FP2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('/internal/banned-fingerprints (BS#1261)', () => {
  let sql;
  beforeAll(() => {
    sql = makeSql();
  });

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.banned_fingerprints WHERE fingerprint = ANY($1::uuid[])`, [[FP1, FP2]]);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  describe('POST', () => {
    test('401 without X-Internal-Key', async () => {
      const res = await request.post('/internal/banned-fingerprints').send({ fingerprint: FP1, reason: 'spam' });
      expect(res.status).toBe(401);
    });

    test('401 with wrong key', async () => {
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', 'wrong')
        .send({ fingerprint: FP1, reason: 'spam' });
      expect(res.status).toBe(401);
    });

    test('200 with row body on first POST', async () => {
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'spam' });
      expect(res.status).toBe(200);
      expect(res.body.fingerprint).toBe(FP1);
      expect(res.body.ban_reason).toBe('spam');
      expect(res.body.ban_expires_at).toBeNull();

      const rows = await sql.unsafe(
        `SELECT ban_reason FROM ${SCHEMA}.banned_fingerprints WHERE fingerprint = $1::uuid`,
        [FP1]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].ban_reason).toBe('spam');
    });

    test('200 idempotent — second POST upserts reason without erroring', async () => {
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'spam' });
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'updated' });
      expect(res.status).toBe(200);
      expect(res.body.ban_reason).toBe('updated');

      const rows = await sql.unsafe(
        `SELECT COUNT(*)::int AS c FROM ${SCHEMA}.banned_fingerprints WHERE fingerprint = $1::uuid`,
        [FP1]
      );
      expect(rows[0].c).toBe(1);
    });

    test('200 with expiresInSeconds populates ban_expires_at', async () => {
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'temp', expiresInSeconds: 3600 });
      expect(res.status).toBe(200);
      expect(res.body.ban_expires_at).toBeTruthy();
      const expiresAt = new Date(res.body.ban_expires_at).getTime();
      const expected = Date.now() + 3600 * 1000;
      expect(Math.abs(expiresAt - expected)).toBeLessThan(60_000);
    });

    test('trims surrounding whitespace from reason before storing', async () => {
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: '   spammy spammer   ' });
      expect(res.status).toBe(200);
      expect(res.body.ban_reason).toBe('spammy spammer');

      const rows = await sql.unsafe(
        `SELECT ban_reason FROM ${SCHEMA}.banned_fingerprints WHERE fingerprint = $1::uuid`,
        [FP1]
      );
      expect(rows[0].ban_reason).toBe('spammy spammer');
    });

    test('400 when bannedByUserId does not reference an existing auth_user.id', async () => {
      // FK violation (SQLSTATE 23503) should surface as 400 with a clear
      // operator-actionable message, not as a generic 500.
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'spam', bannedByUserId: 'usr_does_not_exist_in_auth_user' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bannedByUserId/);
    });

    test('upsert preserves original banned_by_user_id when re-ban omits it', async () => {
      // Operator A bans with bannedByUserId=null (default). Operator B re-bans
      // omitting bannedByUserId entirely. Original attribution should be
      // preserved (or in this case, both should be null and stay null).
      // Use the staging default user that the seed creates so the FK passes.
      const userRows = await sql.unsafe(`SELECT id FROM auth_user LIMIT 1`);
      if (userRows.length === 0) {
        // No seeded user — skip the attribution-preservation case rather
        // than fabricating an auth_user row in an integration spec.
        return;
      }
      const operatorId = userRows[0].id;

      // Initial ban WITH attribution.
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'initial', bannedByUserId: operatorId });

      // Re-ban WITHOUT attribution. The COALESCE in the on-conflict clause
      // should preserve operatorId rather than NULL it.
      const res = await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'updated reason' });
      expect(res.status).toBe(200);
      expect(res.body.banned_by_user_id).toBe(operatorId);
    });
  });

  describe('DELETE', () => {
    test('401 without X-Internal-Key', async () => {
      const res = await request.delete(`/internal/banned-fingerprints/${FP1}`);
      expect(res.status).toBe(401);
    });

    test('204 after creating then deleting', async () => {
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'spam' });
      const res = await request.delete(`/internal/banned-fingerprints/${FP1}`).set('X-Internal-Key', KEY);
      expect(res.status).toBe(204);

      const rows = await sql.unsafe(`SELECT 1 FROM ${SCHEMA}.banned_fingerprints WHERE fingerprint = $1::uuid`, [FP1]);
      expect(rows).toHaveLength(0);
    });

    test('204 when row does not exist (idempotent)', async () => {
      const res = await request.delete(`/internal/banned-fingerprints/${FP1}`).set('X-Internal-Key', KEY);
      expect(res.status).toBe(204);
    });
  });

  describe('GET', () => {
    test('401 without X-Internal-Key', async () => {
      const res = await request.get('/internal/banned-fingerprints');
      expect(res.status).toBe(401);
    });

    test('200 returns items and nextCursor', async () => {
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'first' });
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP2, reason: 'second' });

      const res = await request.get('/internal/banned-fingerprints').set('X-Internal-Key', KEY);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const fingerprintsReturned = res.body.items.map((r) => r.fingerprint);
      expect(fingerprintsReturned).toEqual(expect.arrayContaining([FP1, FP2]));
    });

    // Regression guard for the drizzle date-serializer trap (BS#802 lineage):
    // raw `Date` bound into `sql\`\`` flows into postgres-js's Bind layer
    // unconverted and throws ERR_INVALID_ARG_TYPE. Unit tests mock the chain
    // so they can't catch this — only a real bind exercises the path. First
    // page returns nextCursor, second page consumes it.
    test('paginated GET with cursor returns 200 (date-serializer regression guard)', async () => {
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP1, reason: 'first' });
      await request
        .post('/internal/banned-fingerprints')
        .set('X-Internal-Key', KEY)
        .send({ fingerprint: FP2, reason: 'second' });

      const page1 = await request.get('/internal/banned-fingerprints?limit=1').set('X-Internal-Key', KEY);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toBeTruthy();

      const page2 = await request
        .get(`/internal/banned-fingerprints?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set('X-Internal-Key', KEY);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      // The second page's row must be different from the first.
      expect(page2.body.items[0].fingerprint).not.toBe(page1.body.items[0].fingerprint);
    });
  });
});
