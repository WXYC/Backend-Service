/**
 * RFC 8628 device-authorization integration spec for ADR 0008 (QR sign-in
 * for the shared control-room computer).
 *
 * Covers the full happy path (browser POSTs /device/code, polls
 * /device/token, iOS app authenticates and POSTs /device/approve, browser's
 * next poll returns a 12h session), the role gate (a `member`-role user
 * gets `access_denied` at /device/approve — the row is un-claimed and a
 * legitimate DJ can approve the same user_code), the deny path (a DJ
 * rejects their own pending code, browser sees `access_denied`), the
 * `slow_down` polling contract (RFC 8628 §3.5), and the rolling-refresh
 * guard (getSession must not walk a 12h device-flow session back out to
 * the 7d default).
 *
 * Coordinates with: shared/authentication/src/auth.definition.ts (plugin
 * registration + hooks + session.update.before cap),
 * shared/authentication/src/device-authorization.ts (extracted helpers),
 * apps/auth/app.ts (rate-limit wiring), and migration 0110
 * (auth_device_code substrate + auth_session.device_flow_expires_at).
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

  test('pre-approval poll returns authorization_pending', async () => {
    // Documenting RFC 8628's interim polling response. Lives in its own
    // test (not in the happy path) so the second poll doesn't run inside
    // the plugin's `pollingInterval` (5s) window — the plugin sets
    // `lastPolledAt` on every /device/token call and returns `slow_down`
    // on any subsequent poll within the interval (routes.mjs:201). The
    // happy path's post-approval poll therefore runs against a fresh row.
    const { body: codeBody } = await requestDeviceCode(authBaseUrl);
    const { res: pendingRes, body: pendingBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(pendingRes.status).toBe(400);
    expect(pendingBody?.error).toBe('authorization_pending');
  });

  test('slow_down: second poll within pollingInterval returns RFC 8628 slow_down (BS#1494 AC)', async () => {
    // The last acceptance criterion on #1494: /auth/device/token returns
    // the plugin's structured `slow_down` JSON body (400) when polled
    // faster than the 5s pollingInterval — NOT an HTTP 429 from
    // express-rate-limit, which would shadow it. express-rate-limit is
    // disabled under NODE_ENV=test (apps/auth/app.ts), so any 429 here
    // would be a regression in the plugin/limit wiring.
    const { body: codeBody } = await requestDeviceCode(authBaseUrl);
    const { res: firstRes, body: firstBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(firstRes.status).toBe(400);
    expect(firstBody?.error).toBe('authorization_pending');
    // Second poll immediately — inside the plugin's 5s interval.
    const { res: secondRes, body: secondBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(secondRes.status).toBe(400);
    expect(secondBody?.error).toBe('slow_down');
  });

  test('happy path: DJ approves, browser receives a 12h session', async () => {
    const { res: codeRes, body: codeBody } = await requestDeviceCode(authBaseUrl);
    expect(codeRes.status).toBe(200);
    expect(typeof codeBody.device_code).toBe('string');
    expect(typeof codeBody.user_code).toBe('string');
    expect(codeBody.verification_uri).toBe('https://dj.wxyc.org/device-auth');

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

    // WXYC/dj-site#841: the shared control-room browser signs in off the
    // session *cookie*, not the bearer `access_token` body. The plugin's token
    // route only setNewSession()s (no setSessionCookie — it's an OAuth token
    // endpoint), so our /device/token after-hook must emit the session cookie,
    // clamped to the same 12h ceiling as the DB row (ADR 0008). Without it the
    // poll 200s but the browser never establishes a session and hangs on /login.
    const tokenSetCookies = tokenRes.headers.getSetCookie();
    const sessionCookie = tokenSetCookies.find((c) => c.startsWith('better-auth.session_token='));
    expect(sessionCookie).toBeDefined();
    // Non-empty signed value, and 12h (43200s) max-age so cookie and DB agree.
    expect(sessionCookie).toMatch(/^better-auth\.session_token=.+/);
    expect(sessionCookie).toMatch(/Max-Age=43200\b/i);

    // Persisted session's expiresAt AND device_flow_expires_at should both
    // match — the row is written in a single UPDATE by the after-hook.
    const rows = await sql.unsafe(`SELECT expires_at, device_flow_expires_at FROM auth_session WHERE token = $1`, [
      tokenBody.access_token,
    ]);
    expect(rows).toHaveLength(1);
    const expiresAtMs = new Date(rows[0].expires_at).getTime();
    const deviceFlowMs = new Date(rows[0].device_flow_expires_at).getTime();
    const targetMs = t0 + 12 * 60 * 60 * 1000;
    // Allow ±15s slack to absorb the post-handler clock drift between
    // route-level createSession and our after-hook's `new Date()`.
    expect(expiresAtMs).toBeGreaterThan(targetMs - 15_000);
    expect(expiresAtMs).toBeLessThan(targetMs + 15_000);
    // device_flow_expires_at IS the cap — if it drifts from expires_at at
    // mint time, we'd let the very first refresh legitimately extend past
    // the ADR's ceiling.
    expect(deviceFlowMs).toBe(expiresAtMs);

    // Clean up the session row so we don't leak across specs.
    await sql.unsafe(`DELETE FROM auth_session WHERE token = $1`, [tokenBody.access_token]);
  });

  test('rolling refresh: /get-session cannot walk a 12h device-flow session past its cap (B3)', async () => {
    // The bug the reviewer flagged: better-auth's getSession fires
    // `internalAdapter.updateSession(token, {expiresAt: now + expiresIn})`
    // whenever the row is past `updateAge` (1d). For a session clamped to
    // 12h, `(mint + 12h) - 7d + 1d ≤ now` is TRUE immediately, so the
    // very first getSession call would try to walk expires_at back out to
    // 7 days. The databaseHooks.session.update.before cap must clamp the
    // write back down to device_flow_expires_at.
    //
    // The test:
    //   1. Fake up an already-clamped device-flow session on an existing
    //      user. We backdate `updated_at` to `now - 2d` (older than the
    //      1d updateAge) so getSession's refresh math triggers on the
    //      very next read.
    //   2. Call /get-session with Bearer <token>.
    //   3. Re-read the row; assert expires_at is still ≈ cap, not now + 7d.
    const users = await sql.unsafe(`SELECT id FROM auth_user WHERE username = 'test_dj1' LIMIT 1`);
    expect(users).toHaveLength(1);
    const userId = users[0].id;

    const token = `qr-refresh-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const now = Date.now();
    const cap = new Date(now + 12 * 60 * 60 * 1000);
    const updatedAt = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await sql.unsafe(
      `INSERT INTO auth_session (id, user_id, token, expires_at, device_flow_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $5)`,
      [sessionId, userId, token, cap, updatedAt]
    );

    const res = await fetch(`${authBaseUrl}/get-session`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const rows = await sql.unsafe(`SELECT expires_at FROM auth_session WHERE token = $1`, [token]);
    expect(rows).toHaveLength(1);
    const nowExpiresAtMs = new Date(rows[0].expires_at).getTime();
    // Absolute upper bound: cap + 1s slack for postgres round-trip. If the
    // refresh went through unclamped, nowExpiresAtMs would be roughly now
    // + 7d = cap + 6.5d.
    expect(nowExpiresAtMs).toBeLessThanOrEqual(cap.getTime() + 1000);

    await sql.unsafe(`DELETE FROM auth_session WHERE token = $1`, [token]);
  });

  test('member-denied path: member at /device/approve gets access_denied, DJ can still approve same code (S1)', async () => {
    const { body: codeBody } = await requestDeviceCode(authBaseUrl);

    const memberCookie = await signIn(authBaseUrl, 'test_member');
    // Member claims first (the plugin's own /device claim step always
    // succeeds — it doesn't know about the role gate, which fires at
    // /device/approve).
    const { res: memberClaimRes } = await claimDeviceCode(authBaseUrl, memberCookie, codeBody.user_code);
    expect(memberClaimRes.status).toBe(200);
    const { res: approveRes, body: approveBody } = await approveDeviceCode(
      authBaseUrl,
      memberCookie,
      codeBody.user_code
    );
    expect(approveRes.status).toBe(403);
    expect(approveBody?.error).toBe('access_denied');

    // The role-gate rejection resets the row's userId (the S1 fix) so the
    // legitimate DJ can claim + approve the same user_code before it TTLs.
    // Without that reset, /device/approve would 403 on the DJ too, because
    // the plugin requires `deviceCodeRecord.userId === session.user.id`.
    const djCookie = await signIn(authBaseUrl, 'test_dj1');
    const { res: djClaimRes } = await claimDeviceCode(authBaseUrl, djCookie, codeBody.user_code);
    expect(djClaimRes.status).toBe(200);
    const { res: djApproveRes } = await approveDeviceCode(authBaseUrl, djCookie, codeBody.user_code);
    expect(djApproveRes.status).toBe(200);

    // Browser's next poll now returns a 12h session — sequenced far enough
    // apart from any prior poll on this device_code to avoid slow_down.
    const { res: pollRes, body: pollBody } = await pollDeviceToken(authBaseUrl, codeBody.device_code);
    expect(pollRes.status).toBe(200);
    expect(typeof pollBody.access_token).toBe('string');

    await sql.unsafe(`DELETE FROM auth_session WHERE token = $1`, [pollBody.access_token]);
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
