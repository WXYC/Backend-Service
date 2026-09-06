/**
 * Integration tests for `POST /auth/wxyc/station-signup` (BS#2361), the
 * passcode-gated self-signup endpoint.
 *
 * Two cases from the issue body are deliberately NOT here, with the
 * reasoning recorded rather than silently dropped:
 *
 *   - "feature-off 404": this file talks to the SAME long-running auth
 *     service every other case in it uses, which CI starts once with
 *     STATION_SIGNUP_ENABLED=true (dev_env/docker-compose.yml,
 *     .github/workflows/test.yml — same test-coverage-not-rollout shape as
 *     FLOWSHEET_TAKEOVER_ENABLED/DIGITAL_ARCHIVE_STREAMING_ENABLED, neither
 *     of which re-tests its OFF state against a live server either). There
 *     is no live route to flip the flag mid-suite. Covered instead by
 *     tests/unit/auth/station-signup.test.ts, which calls
 *     stationSignupFromRequest directly with the env var unset.
 *   - "verification email sent": EMAIL_ENABLED=false in every test
 *     environment (see docs/env-vars.md), so `sendEmail` returns before
 *     touching SES and there is no observable side effect here to assert
 *     against — matching every other integration spec in this suite, none
 *     of which asserts a real send either. Covered instead by the same unit
 *     test, which mocks sendVerificationEmailMessage directly.
 *
 * Like station-passcode.spec.js, this file mints real encrypted passcode
 * rows by calling the compiled station-passcode module directly (bypassing
 * the @wxyc/authentication barrel, which imports better-auth — pure ESM,
 * unloadable via Jest's plain CJS require). The auth SERVICE this file talks
 * to over HTTP is a separate process, so both must be started with the
 * IDENTICAL STATION_PASSCODE_KEY or nothing this file mints will decrypt
 * there — see the comments in dev_env/docker-compose.yml and
 * .github/workflows/test.yml next to that var.
 */

jest.unmock('drizzle-orm');

process.env.STATION_PASSCODE_KEY =
  process.env.STATION_PASSCODE_KEY || '5a859c11b96205498dda4b3cbe21c1c956d472104ee1d85ca2058cb8535ab28b';

const {
  rotateStationPasscode,
  revokeStationPasscode,
  clearSignupCooldown,
} = require('../../shared/authentication/dist/station-passcode.js');

const { getTestDb } = require('../utils/db');

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

let uniqueCounter = 0;
function uniqueSuffix() {
  uniqueCounter += 1;
  // No hyphens: `validateUsername`'s regex is /^[a-zA-Z0-9_.]+$/.
  return `${Date.now()}_${uniqueCounter}`;
}

function validBody(overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    username: `stationsignup_${suffix}`,
    email: `stationsignup_${suffix}@wxyc.org`,
    password: 'SignupPass123',
    realName: 'Integration Test DJ',
    djName: 'DJ Integration',
    ...overrides,
  };
}

async function postSignup(authBaseUrl, passcode, body) {
  const res = await fetch(`${authBaseUrl}/wxyc/station-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode, ...body }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { res, json };
}

async function signIn(authBaseUrl, username, password) {
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

describe('POST /auth/wxyc/station-signup (BS#2361, real Postgres + live auth service)', () => {
  const authBaseUrl = getAuthBaseUrl();
  let sql;
  const createdUserIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  // Exclusive to this spec's own rows: unique-suffixed usernames/emails, plus
  // a full wipe of the station-signup tables (both are hand-rolled and
  // exclusive to this feature — same as station-passcode.spec.js).
  beforeEach(async () => {
    await sql`DELETE FROM station_signup_attempt`;
    await sql`DELETE FROM station_passcode`;
  });

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await sql`DELETE FROM auth_user WHERE id = ANY(${createdUserIds})`;
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM station_signup_attempt`;
    await sql`DELETE FROM station_passcode`;
  });

  async function passcodeRow(id) {
    const rows = await sql`SELECT use_count, max_uses FROM station_passcode WHERE id = ${id}`;
    return rows[0];
  }

  describe('golden path', () => {
    it('provisions a dj with the server-pinned fields, claims one use, and mints no setup invite', async () => {
      const { id, code } = await rotateStationPasscode();
      const body = validBody();

      const { res, json } = await postSignup(authBaseUrl, code, body);
      expect(res.status).toBe(201);
      expect(json).toMatchObject({ status: true, email: body.email, username: body.username });
      createdUserIds.push(json.userId);

      const [userRow] = await sql`
        SELECT has_completed_onboarding, self_signup_at, self_signup_reviewed_at
        FROM auth_user WHERE id = ${json.userId}
      `;
      expect(userRow.has_completed_onboarding).toBe(true);
      expect(userRow.self_signup_at).not.toBeNull();
      expect(userRow.self_signup_reviewed_at).toBeNull();

      const [memberRow] = await sql`SELECT role FROM auth_member WHERE user_id = ${json.userId}`;
      expect(memberRow.role).toBe('dj');

      const row = await passcodeRow(id);
      expect(row.use_count).toBe(1);

      // No setup invite: provisionUser was called with sendSetupInvite:
      // false, so no long-lived reset-password token should exist for a
      // password this DJ already chose themselves.
      const invites = await sql`
        SELECT id FROM auth_verification WHERE identifier LIKE 'reset-password:%' AND value = ${json.userId}
      `;
      expect(invites).toHaveLength(0);

      const attempts = await sql`SELECT outcome FROM station_signup_attempt`;
      expect(attempts.map((a) => a.outcome)).toEqual(['passcode_ok']);
    });

    it('ignores a client-supplied role — the account is always provisioned as dj', async () => {
      const { code } = await rotateStationPasscode();
      const body = validBody({ role: 'stationManager' });

      const { res, json } = await postSignup(authBaseUrl, code, body);
      expect(res.status).toBe(201);
      createdUserIds.push(json.userId);

      const [memberRow] = await sql`SELECT role FROM auth_member WHERE user_id = ${json.userId}`;
      expect(memberRow.role).toBe('dj');

      const [userRow] = await sql`SELECT role FROM auth_user WHERE id = ${json.userId}`;
      // grantsAdminFlag is stationManager-only; a dj member must never carry
      // the global admin flag.
      expect(userRow.role).not.toBe('admin');
    });

    it('a signed-in self-signed-up DJ cannot self-approve their own review via POST /update-user', async () => {
      const { code } = await rotateStationPasscode();
      const body = validBody();

      const { json } = await postSignup(authBaseUrl, code, body);
      createdUserIds.push(json.userId);

      const cookie = await signIn(authBaseUrl, body.username, body.password);
      await fetch(`${authBaseUrl}/update-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ selfSignupReviewedAt: new Date().toISOString() }),
      });

      const [userRow] = await sql`SELECT self_signup_reviewed_at FROM auth_user WHERE id = ${json.userId}`;
      expect(userRow.self_signup_reviewed_at).toBeNull();
    });
  });

  describe('invalid passcode — the response never distinguishes why', () => {
    it('a wrong code is refused and claims no use', async () => {
      const { id } = await rotateStationPasscode();
      const body = validBody();

      const { res } = await postSignup(authBaseUrl, 'ZZZZZZZZ', body);
      expect(res.status).toBe(401);

      const row = await passcodeRow(id);
      expect(row.use_count).toBe(0);

      const [userRow] = await sql`SELECT id FROM auth_user WHERE username = ${body.username}`;
      expect(userRow).toBeUndefined();
    });

    it('an expired code is refused and claims no use', async () => {
      const { id, code } = await rotateStationPasscode();
      await sql`UPDATE station_passcode SET expires_at = now() - interval '1 minute' WHERE id = ${id}`;

      const { res } = await postSignup(authBaseUrl, code, validBody());
      expect(res.status).toBe(401);
      expect((await passcodeRow(id)).use_count).toBe(0);
    });

    it('a revoked code is refused and claims no use', async () => {
      const { id, code } = await rotateStationPasscode();
      await revokeStationPasscode(id, { revokedReason: 'test revoke' });

      const { res } = await postSignup(authBaseUrl, code, validBody());
      expect(res.status).toBe(401);
      expect((await passcodeRow(id)).use_count).toBe(0);
    });

    it('a code at its use cap is refused after the cap is reached', async () => {
      const { id, code } = await rotateStationPasscode({ maxUses: 1 });

      const first = await postSignup(authBaseUrl, code, validBody());
      expect(first.res.status).toBe(201);
      createdUserIds.push(first.json.userId);
      expect((await passcodeRow(id)).use_count).toBe(1);

      const second = await postSignup(authBaseUrl, code, validBody());
      expect(second.res.status).toBe(401);
      // Still 1 — the exhausted claim never increments past the cap.
      expect((await passcodeRow(id)).use_count).toBe(1);
    });
  });

  describe('cooldown refusal', () => {
    // clearSignupCooldown's actorUserId is a real FK into auth_user — this is
    // the stationManager fixture seed_db.sql already seeds for admin-flow
    // specs, reused here purely as a valid id, not for its role.
    const CLEAR_ACTOR_USER_ID = 'test-sm-id-0000000000000000001';

    afterEach(async () => {
      // Never leave the station-global cooldown armed for later tests/files
      // sharing this database — the clear is a floor on the window, not a
      // deletion (see clearSignupCooldown's own doc comment).
      await clearSignupCooldown(CLEAR_ACTOR_USER_ID);
    });

    it('refuses with a wait-time message once the no-match threshold is crossed, without ever touching a passcode row', async () => {
      const { id, code } = await rotateStationPasscode();
      // SIGNUP_COOLDOWN_THRESHOLD is "more than 20 in 10 minutes". The
      // passcode gate is the FIRST thing a well-formed request reaches, so
      // every one of these logs a genuine passcode_fail regardless of what
      // the rest of the body says.
      const wrongBody = validBody();
      for (let i = 0; i < 21; i++) {
        // eslint-disable-next-line no-await-in-loop
        const { res } = await postSignup(authBaseUrl, 'ZZZZZZZZ', wrongBody);
        expect(res.status).toBe(401);
      }

      // The 22nd request carries the genuinely correct code, but the
      // cooldown check runs BEFORE verification — it must never reach (or
      // claim) the real row.
      const { res, json } = await postSignup(authBaseUrl, code, wrongBody);
      expect(res.status).toBe(429);
      expect(json.error).toMatch(/minutes/i);
      expect((await passcodeRow(id)).use_count).toBe(0);
    });
  });

  describe('pre-claim validation — duplicates and weak input never CLAIM a use', () => {
    it('rejects a duplicate email without claiming a use', async () => {
      const { id, code } = await rotateStationPasscode();
      const first = validBody();
      const okRes = await postSignup(authBaseUrl, code, first);
      expect(okRes.res.status).toBe(201);
      createdUserIds.push(okRes.json.userId);
      expect((await passcodeRow(id)).use_count).toBe(1);

      const second = validBody({ email: first.email });
      const { res } = await postSignup(authBaseUrl, code, second);
      expect(res.status).toBe(409);
      // Still 1 — the duplicate-email retry must not burn a second use.
      expect((await passcodeRow(id)).use_count).toBe(1);
    });

    it('rejects a duplicate username without claiming a use', async () => {
      const { id, code } = await rotateStationPasscode();
      const first = validBody();
      const okRes = await postSignup(authBaseUrl, code, first);
      expect(okRes.res.status).toBe(201);
      createdUserIds.push(okRes.json.userId);
      expect((await passcodeRow(id)).use_count).toBe(1);

      const second = validBody({ username: first.username });
      const { res } = await postSignup(authBaseUrl, code, second);
      expect(res.status).toBe(409);
      expect((await passcodeRow(id)).use_count).toBe(1);
    });

    it('rejects a weak password without claiming a use', async () => {
      const { id, code } = await rotateStationPasscode();
      const body = validBody({ password: 'short1' });

      const { res } = await postSignup(authBaseUrl, code, body);
      expect(res.status).toBe(400);
      expect((await passcodeRow(id)).use_count).toBe(0);
    });

    // BS#2361 review, finding 2. better-auth's username plugin lowercases on
    // store and duplicate-checks the lowercased value, so a raw-case
    // pre-check missed this row entirely: the request claimed a use and then
    // died inside the plugin's create hook with "Username is already taken.
    // Please try another." — a 500 with the use burned.
    it('rejects a case-variant duplicate username as a 409, without claiming a second use', async () => {
      const { id, code } = await rotateStationPasscode();
      const first = validBody();
      const okRes = await postSignup(authBaseUrl, code, first);
      expect(okRes.res.status).toBe(201);
      createdUserIds.push(okRes.json.userId);
      expect((await passcodeRow(id)).use_count).toBe(1);

      const second = validBody({ username: first.username.toUpperCase() });
      const { res } = await postSignup(authBaseUrl, code, second);
      expect(res.status).toBe(409);
      expect((await passcodeRow(id)).use_count).toBe(1);
    });

    it('stores and echoes the username lowercased', async () => {
      const { code } = await rotateStationPasscode();
      const body = validBody();
      const mixedCase = { ...body, username: body.username.toUpperCase() };

      const { res, json } = await postSignup(authBaseUrl, code, mixedCase);
      expect(res.status).toBe(201);
      createdUserIds.push(json.userId);

      expect(json.username).toBe(body.username.toLowerCase());
      const [userRow] = await sql`SELECT username FROM auth_user WHERE id = ${json.userId}`;
      expect(userRow.username).toBe(body.username.toLowerCase());
    });

    it('rejects an over-length realName without claiming a use', async () => {
      const { id, code } = await rotateStationPasscode();
      const body = validBody({ realName: 'R'.repeat(256) });

      const { res } = await postSignup(authBaseUrl, code, body);
      expect(res.status).toBe(400);
      expect((await passcodeRow(id)).use_count).toBe(0);
    });
  });

  // BS#2361 review, finding 1. The existence checks used to run BEFORE the
  // passcode was ever looked at, so an unauthenticated caller with a garbage
  // code read email-registration status straight off the status code (409
  // EMAIL_TAKEN, with the address echoed back, versus 401) — and those
  // pre-claim rejections wrote no station_signup_attempt row at all, leaving
  // the probe invisible to the cooldown and to #2362/#2364.
  describe('the passcode gate runs before anything a caller can enumerate', () => {
    it('answers a garbage passcode identically for a registered and an unregistered email', async () => {
      const { code } = await rotateStationPasscode();

      // Register one address for real, so the two probes below differ only
      // in whether the email exists.
      const registered = validBody();
      const okRes = await postSignup(authBaseUrl, code, registered);
      expect(okRes.res.status).toBe(201);
      createdUserIds.push(okRes.json.userId);

      const takenProbe = await postSignup(authBaseUrl, 'ZZZZZZZZ', validBody({ email: registered.email }));
      const freshProbe = await postSignup(authBaseUrl, 'ZZZZZZZZ', validBody());

      expect(takenProbe.res.status).toBe(401);
      expect(takenProbe.res.status).toBe(freshProbe.res.status);
      expect(JSON.stringify(takenProbe.json)).toBe(JSON.stringify(freshProbe.json));
      // And neither probe echoes the address it was handed.
      expect(JSON.stringify(takenProbe.json)).not.toContain(registered.email);
    });

    it('logs an attempt row for a garbage passcode carrying an already-registered email', async () => {
      const { code } = await rotateStationPasscode();
      const registered = validBody();
      const okRes = await postSignup(authBaseUrl, code, registered);
      expect(okRes.res.status).toBe(201);
      createdUserIds.push(okRes.json.userId);

      await sql`DELETE FROM station_signup_attempt`;
      const { res } = await postSignup(authBaseUrl, 'ZZZZZZZZ', validBody({ email: registered.email }));
      expect(res.status).toBe(401);

      // Exactly one row, and it is the refusal token the cooldown counts —
      // the old ordering wrote nothing here.
      const attempts = await sql`SELECT outcome FROM station_signup_attempt`;
      expect(attempts.map((a) => a.outcome)).toEqual(['passcode_fail']);
    });
  });
});
