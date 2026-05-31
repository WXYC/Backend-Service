/**
 * Integration tests for POST /auth/check-request-ban (BS#1261).
 *
 * Exercises the live auth service against a real Postgres. Covers the four
 * branches the unit suite mocks: no_signal (400), valid JWT + not banned,
 * valid JWT + user banned (via /admin/ban-user), and fingerprint banned (via
 * direct INSERT into banned_fingerprints). The fingerprint path bypasses
 * any HTTP write side so it doesn't depend on the /internal CRUD landing
 * concurrently.
 */

const postgres = require('postgres');
const { signInAnonymous, banUser, unbanUser } = require('../utils/anonymous_auth');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

function getAuthBaseUrl() {
  if (process.env.BETTER_AUTH_URL) {
    try {
      return new URL(process.env.BETTER_AUTH_URL).toString().replace(/\/$/, '');
    } catch {
      // fall through
    }
  }
  const host = process.env.AUTH_HOST || 'localhost';
  const port = process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083;
  return `http://${host}:${port}/auth`;
}

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

/**
 * Sign in anonymously and then exchange the session token for a JWT via
 * `/token` (the same flow iOS uses).
 */
async function getAnonymousJwt(authBaseUrl) {
  const { token: sessionToken, userId } = await signInAnonymous();
  const jwtRes = await fetch(`${authBaseUrl}/token`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!jwtRes.ok) {
    throw new Error(`Failed to fetch JWT: ${jwtRes.status} ${await jwtRes.text()}`);
  }
  const { token } = await jwtRes.json();
  return { jwt: token, userId };
}

describe('POST /auth/check-request-ban (BS#1261)', () => {
  const authBaseUrl = getAuthBaseUrl();
  let sql;
  // Track fingerprints written by these tests so afterEach can delete them.
  const insertedFingerprints = [];

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    if (insertedFingerprints.length > 0) {
      await sql.unsafe(`DELETE FROM ${SCHEMA}.banned_fingerprints WHERE fingerprint = ANY($1::uuid[])`, [
        insertedFingerprints.splice(0),
      ]);
    }
  });

  test('400 no_signal when neither JWT nor fingerprint is provided', async () => {
    const res = await fetch(`${authBaseUrl}/check-request-ban`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no_signal' });
  });

  test('200 banned:false when valid JWT but user is not banned', async () => {
    const { jwt, userId } = await getAnonymousJwt(authBaseUrl);

    const res = await fetch(`${authBaseUrl}/check-request-ban`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.banned).toBe(false);
    expect(body.userId).toBe(userId);
    expect(body.fingerprint).toBeNull();
  });

  // Requires admin credentials (AUTH_USERNAME/AUTH_PASSWORD) — skip when not
  // configured. Mirrors the existing pattern in requestLine.spec.js.
  const adminCredsAvailable = !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD);
  const itIfAdminCreds = adminCredsAvailable ? test : test.skip;

  itIfAdminCreds('200 banned:true with banSource:"user" when better-auth banUser was called', async () => {
    const { jwt, userId } = await getAnonymousJwt(authBaseUrl);
    await banUser(userId, 'integration-test ban');

    try {
      const res = await fetch(`${authBaseUrl}/check-request-ban`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.banned).toBe(true);
      expect(body.banSource).toBe('user');
      expect(body.banReason).toBe('integration-test ban');
    } finally {
      await unbanUser(userId);
    }
  });

  test('200 banned:true with banSource:"fingerprint" when banned_fingerprints row exists', async () => {
    const fingerprint = '22222222-2222-2222-2222-222222222222';
    await sql.unsafe(`INSERT INTO ${SCHEMA}.banned_fingerprints (fingerprint, ban_reason) VALUES ($1::uuid, $2)`, [
      fingerprint,
      'integration-test fingerprint ban',
    ]);
    insertedFingerprints.push(fingerprint);

    const res = await fetch(`${authBaseUrl}/check-request-ban`, {
      method: 'POST',
      headers: { 'X-Device-Fingerprint': fingerprint },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.banned).toBe(true);
    expect(body.banSource).toBe('fingerprint');
    expect(body.banReason).toBe('integration-test fingerprint ban');
    expect(body.fingerprint).toBe(fingerprint);
    expect(body.userId).toBeNull();
  });

  test('200 banned:false when fingerprint ban has expired', async () => {
    const fingerprint = '33333333-3333-3333-3333-333333333333';
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.banned_fingerprints (fingerprint, ban_reason, ban_expires_at) VALUES ($1::uuid, $2, now() - interval '1 hour')`,
      [fingerprint, 'expired']
    );
    insertedFingerprints.push(fingerprint);

    const res = await fetch(`${authBaseUrl}/check-request-ban`, {
      method: 'POST',
      headers: { 'X-Device-Fingerprint': fingerprint },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.banned).toBe(false);
  });

  test('401 invalid_token on malformed Authorization header', async () => {
    const res = await fetch(`${authBaseUrl}/check-request-ban`, {
      method: 'POST',
      headers: { Authorization: 'not-bearer' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });
});
