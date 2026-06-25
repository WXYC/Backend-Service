/**
 * RFC 8628 device-authorization integration spec for ADR 0008 (QR sign-in
 * for the shared control-room computer).
 *
 * Covers the full happy path (browser POSTs /device/code, polls
 * /device/token, iOS app authenticates and POSTs /device/approve, browser's
 * next poll returns a 12h session), the role gate (a `member`-role user
 * gets `access_denied` at /device/approve, which propagates to the
 * browser's /device/token poll), and the deny path (a DJ rejects their own
 * pending code, browser sees `access_denied`).
 *
 * Coordinates with: shared/authentication/src/auth.definition.ts (plugin
 * registration + hooks), shared/authentication/src/device-authorization.ts
 * (extracted helpers), apps/auth/app.ts (rate-limit wiring), and migration
 * 0106 (auth_device_code substrate).
 */

const postgres = require('postgres');

const ORG_SLUG = process.env.DEFAULT_ORG_SLUG || 'test-org';

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

async function signIn(authBaseUrl, username, password = 'testpassword123') {
  const res = await fetch(`${authBaseUrl}/sign-in/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Sign-in failed for ${username}: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie();
  if (!cookies || cookies.length === 0) throw new Error('No session cookie returned by sign-in');
  return cookies.map((c) => c.split(';')[0].trim()).join('; ');
}

async function requestDeviceCode(authBaseUrl) {
  const res = await fetch(`${authBaseUrl}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'dj-site' }),
  });
  const body = await res.json();
  return { res, body };
}

async function pollDeviceToken(authBaseUrl, deviceCode) {
  const res = await fetch(`${authBaseUrl}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'dj-site',
    }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { res, body };
}

async function claimDeviceCode(authBaseUrl, cookie, userCode) {
  // GET /device?user_code=… is the claim step. The plugin's handler reads
  // the session from the request and, if the row has no userId, atomically
  // sets userId = session.user.id. /device/approve and /device/deny both
  // require the row to be claimed before they'll accept it.
  const res = await fetch(`${authBaseUrl}/device?user_code=${encodeURIComponent(userCode)}`, {
    method: 'GET',
    headers: { Cookie: cookie },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { res, body };
}

async function approveDeviceCode(authBaseUrl, cookie, userCode) {
  const res = await fetch(`${authBaseUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ userCode }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { res, body };
}

async function denyDeviceCode(authBaseUrl, cookie, userCode) {
  const res = await fetch(`${authBaseUrl}/device/deny`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ userCode }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { res, body };
}

describe('QR device-authorization (ADR 0008)', () => {
  const authBaseUrl = getAuthBaseUrl();
  let sql;

  beforeAll(async () => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    // Drain any rows the test left behind — keeps the unique (device_code,
    // user_code) namespace clean for the next spec.
    await sql.unsafe(`DELETE FROM auth_device_code`);
  });

  test('happy path: DJ approves, browser receives a 12h session', async () => {
    const { res: codeRes, body: codeBody } = await requestDeviceCode(authBaseUrl);
    expect(codeRes.status).toBe(200);
    expect(typeof codeBody.device_code).toBe('string');
    expect(typeof codeBody.user_code).toBe('string');
    expect(codeBody.verification_uri).toBe('https://dj.wxyc.org/device-auth');

    // First poll before approval → 400 authorization_pending.
    const { res: pendingRes, body: pendingBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(pendingRes.status).toBe(400);
    expect(pendingBody?.error).toBe('authorization_pending');

    // iOS scans the QR. /device claims the code (sets userId = DJ's id),
    // then /device/approve flips status to approved.
    const djCookie = await signIn(authBaseUrl, 'test_dj1');
    const { res: claimRes } = await claimDeviceCode(authBaseUrl, djCookie, codeBody.user_code);
    expect(claimRes.status).toBe(200);
    const { res: approveRes } = await approveDeviceCode(authBaseUrl, djCookie, codeBody.user_code);
    expect(approveRes.status).toBe(200);

    // Browser's next poll → 200 with a 12h session.
    const t0 = Date.now();
    const { res: tokenRes, body: tokenBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(tokenRes.status).toBe(200);
    expect(typeof tokenBody.access_token).toBe('string');
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBe(12 * 60 * 60);

    // Persisted session's expiresAt should match.
    const rows = await sql.unsafe(`SELECT expires_at FROM auth_session WHERE token = $1`, [tokenBody.access_token]);
    expect(rows).toHaveLength(1);
    const expiresAtMs = new Date(rows[0].expires_at).getTime();
    const targetMs = t0 + 12 * 60 * 60 * 1000;
    // Allow ±15s slack to absorb the post-handler clock drift between
    // route-level createSession and our after-hook's `new Date()`.
    expect(expiresAtMs).toBeGreaterThan(targetMs - 15_000);
    expect(expiresAtMs).toBeLessThan(targetMs + 15_000);

    // Clean up the session row so we don't leak across specs.
    await sql.unsafe(`DELETE FROM auth_session WHERE token = $1`, [tokenBody.access_token]);
  });

  test('member-denied path: member at /device/approve gets access_denied, browser sees authorization_pending', async () => {
    const { body: codeBody } = await requestDeviceCode(authBaseUrl);

    const memberCookie = await signIn(authBaseUrl, 'test_member');
    // Member claims first (the plugin's own /device claim step always
    // succeeds — it doesn't know about the role gate, which fires at
    // /device/approve).
    const { res: claimRes } = await claimDeviceCode(authBaseUrl, memberCookie, codeBody.user_code);
    expect(claimRes.status).toBe(200);
    const { res: approveRes, body: approveBody } = await approveDeviceCode(
      authBaseUrl,
      memberCookie,
      codeBody.user_code
    );
    expect(approveRes.status).toBe(403);
    expect(approveBody?.error).toBe('access_denied');

    // Role gate aborted the approve in hooks.before, so the row's status
    // is still `pending` — the next /device/token poll returns
    // authorization_pending. (The userId was set on the row by the
    // member's claim, which is acceptable behavior for v1: the DJ's
    // re-claim is a no-op, so the member effectively "burns" the
    // user_code on this run and the DJ scans a fresh QR.)
    const { res: pollRes, body: pollBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(pollRes.status).toBe(400);
    expect(pollBody?.error).toBe('authorization_pending');
  });

  test('deny path: DJ denies their own claimed code, browser sees access_denied', async () => {
    const { body: codeBody } = await requestDeviceCode(authBaseUrl);

    const djCookie = await signIn(authBaseUrl, 'test_dj1');
    const { res: claimRes } = await claimDeviceCode(authBaseUrl, djCookie, codeBody.user_code);
    expect(claimRes.status).toBe(200);
    const { res: denyRes } = await denyDeviceCode(authBaseUrl, djCookie, codeBody.user_code);
    expect(denyRes.status).toBe(200);

    const { res: pollRes, body: pollBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(pollRes.status).toBe(400);
    expect(pollBody?.error).toBe('access_denied');
  });
});
