/**
 * Integration tests for the station-signup manager API (BS#2362): reveal,
 * rotate, revoke, clear-cooldown, status, and approve.
 *
 * These drive the REAL endpoints over HTTP against the running auth service
 * and assert against real Postgres, because every property worth testing here
 * is a side effect on a row rather than a return value:
 *
 *   - the admin-flag gate is middleware-shaped, so only a real request can
 *     show that an unauthenticated caller and a plain-DJ session are both
 *     turned away from all six routes;
 *   - reveal's audit row is the thing that REPLACES show-once storage's
 *     structural guarantee, so "the plaintext came back" is only half the
 *     assertion — the `passcode_revealed` row carrying the acting manager's
 *     id is the other half, and it must carry the SESSION's id, not one the
 *     caller could have named;
 *   - clear-cooldown's whole contract is "writes a floor row, deletes
 *     nothing", which is a statement about what is still in the attempt log
 *     afterwards;
 *   - approve shares a mandatory `auth_user`-first lock order with
 *     `jobs/station-signup-review`'s actuator, and the last case here runs
 *     that job's REAL compiled `applyDowngrades` against an account this
 *     endpoint just approved.
 *
 * The auth service needs `STATION_PASSCODE_KEY` to be set; CI's "Start
 * services" step and `dev_env/docker-compose.yml`'s ci profile both set a
 * fixed test key. This spec never needs the key itself — it obtains plaintext
 * only from the endpoints' own responses.
 */

// `tests/__mocks__/drizzle-orm.ts` is auto-applied to every `drizzle-orm`
// require (it exists for the ts-jest unit tier). The compiled job bundle the
// race case drives needs the REAL drizzle-orm, whose query builder produces
// the SQL `@wxyc/database`'s driver runs. Same pattern as
// `station-signup-review.spec.js`. Hoisted above the requires below.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'station-signup-review', 'dist');
const { queryPendingSelfSignups } = require(path.join(distDir, 'query.cjs'));
const { planDowngrades, applyDowngrades } = require(path.join(distDir, 'downgrade.cjs'));
const { db } = require('@wxyc/database');

const BASE = '/auth/admin/station-signup';

/** Every route this issue adds, with the method it answers on. Drives the gate table below. */
const ROUTES = [
  { method: 'POST', path: `${BASE}/reveal` },
  { method: 'POST', path: `${BASE}/rotate` },
  { method: 'POST', path: `${BASE}/revoke` },
  { method: 'POST', path: `${BASE}/clear-cooldown` },
  { method: 'GET', path: `${BASE}/status` },
  { method: 'POST', path: `${BASE}/approve` },
];

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

/** Root of the auth service (getAuthBaseUrl() already ends in `/auth`, which every route below repeats). */
const authRoot = () => getAuthBaseUrl().replace(/\/auth$/, '');

async function signIn(username, password = 'testpassword123') {
  const res = await fetch(`${getAuthBaseUrl()}/sign-in/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Sign-in as ${username} failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie();
  if (!cookies || cookies.length === 0) throw new Error(`No session cookie returned signing in as ${username}`);
  return cookies.map((c) => c.split(';')[0].trim()).join('; ');
}

async function call(method, routePath, { cookie, body } = {}) {
  const res = await fetch(`${authRoot()}${routePath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (an HTML 404 from a route that isn't mounted) — the
    // status assertion still reports usefully, and `raw` carries the rest.
  }
  return { status: res.status, body: json, raw: text };
}

describe('station-signup manager API (BS#2362, real endpoints, real Postgres)', () => {
  let sql;
  let managerCookie;
  let djCookie;
  let managerUserId;
  let organizationId;
  /** Seeded `auth_user` ids, deleted in afterEach (auth_member CASCADEs). */
  const userIds = [];
  let previousDowngradeFlag;

  const uniqueId = () => `ssa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** Seed one self-signed-up account plus its membership row in the default org. */
  async function seedAccount({ daysPending = 31, memberRole = 'dj', downgraded = false, selfSignup = true } = {}) {
    const id = uniqueId();
    await sql`
      INSERT INTO auth_user (id, name, email, role, self_signup_at, self_signup_downgraded_at)
      VALUES (
        ${id},
        'SSA Test DJ',
        ${`${id}@test.wxyc.org`},
        'user',
        ${selfSignup ? sql`now() - make_interval(days => ${daysPending})` : null},
        ${downgraded ? sql`now()` : null}
      )
    `;
    userIds.push(id);
    await sql`
      INSERT INTO auth_member (id, organization_id, user_id, role)
      VALUES (${`${id}-m`}, ${organizationId}, ${id}, ${memberRole})
    `;
    return id;
  }

  const authUserRowOf = async (userId) => {
    const rows = await sql`
      SELECT self_signup_at, self_signup_reviewed_at, self_signup_reviewed_by, self_signup_downgraded_at, role
      FROM auth_user WHERE id = ${userId}
    `;
    return rows[0];
  };

  const memberRoleOf = async (userId) => {
    const rows = await sql`SELECT role FROM auth_member WHERE user_id = ${userId}`;
    return rows[0]?.role ?? null;
  };

  const attemptsWithOutcome = async (outcome) =>
    sql`SELECT * FROM station_signup_attempt WHERE outcome = ${outcome} ORDER BY attempted_at ASC`;

  /** Seed n `passcode_fail` rows spread across the last `spreadSeconds` seconds. */
  async function seedFailures(n, spreadSeconds = 120) {
    for (let i = 0; i < n; i += 1) {
      await sql`
        INSERT INTO station_signup_attempt (id, attempted_at, outcome)
        VALUES (${`${uniqueId()}-f${i}`}, now() - make_interval(secs => ${(i * spreadSeconds) / n}), 'passcode_fail')
      `;
    }
  }

  beforeAll(async () => {
    sql = getTestDb();
    managerCookie = await signIn('test_station_manager');
    djCookie = await signIn('test_dj1');

    const managerRows = await sql`SELECT id FROM auth_user WHERE username = 'test_station_manager'`;
    if (managerRows.length === 0) throw new Error('test_station_manager fixture account is missing');
    managerUserId = managerRows[0].id;

    const orgs = await sql`SELECT id FROM auth_organization ORDER BY created_at ASC LIMIT 1`;
    if (orgs.length === 0) throw new Error('No auth_organization row; cannot seed auth_member.');
    organizationId = orgs[0].id;

    previousDowngradeFlag = process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'true';
  });

  afterAll(async () => {
    if (previousDowngradeFlag === undefined) delete process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
    else process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = previousDowngradeFlag;
    await sql`DELETE FROM station_signup_attempt`;
    await sql`DELETE FROM station_passcode`;
  });

  // Both tables are exclusive to the passcode specs in this database, so a
  // wholesale wipe between cases is safe — same as station-passcode.spec.js.
  beforeEach(async () => {
    await sql`DELETE FROM station_signup_attempt`;
    await sql`DELETE FROM station_passcode`;
  });

  afterEach(async () => {
    if (userIds.length > 0) {
      // auth_member's FK to auth_user is ON DELETE CASCADE.
      await sql`DELETE FROM auth_user WHERE id = ANY(${userIds})`;
      userIds.length = 0;
    }
  });

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  describe('admin-flag gate', () => {
    it.each(ROUTES)('$method $path rejects an unauthenticated caller with 401', async ({ method, path: routePath }) => {
      const res = await call(method, routePath, { body: method === 'POST' ? {} : undefined });
      expect(res.status).toBe(401);
    });

    it.each(ROUTES)('$method $path rejects a plain DJ session with 403', async ({ method, path: routePath }) => {
      const res = await call(method, routePath, { cookie: djCookie, body: method === 'POST' ? {} : undefined });
      expect(res.status).toBe(403);
    });

    it('a rejected call writes NOTHING — no passcode row, no attempt row', async () => {
      await call('POST', `${BASE}/rotate`, { cookie: djCookie, body: {} });
      await call('POST', `${BASE}/reveal`, { cookie: djCookie, body: {} });
      await call('POST', `${BASE}/clear-cooldown`, { cookie: djCookie, body: {} });

      const passcodes = await sql`SELECT * FROM station_passcode`;
      const attempts = await sql`SELECT * FROM station_signup_attempt`;
      expect(passcodes).toHaveLength(0);
      expect(attempts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rotate
  // -------------------------------------------------------------------------

  describe('rotate', () => {
    it('returns the plaintext once, persists an active row, and attributes created_by to the acting manager', async () => {
      const res = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });

      expect(res.status).toBe(200);
      expect(typeof res.body.code).toBe('string');
      expect(res.body.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
      expect(res.body.autoRevokedPasscodeIds).toEqual([]);

      const rows = await sql`SELECT * FROM station_passcode WHERE id = ${res.body.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].created_by).toBe(managerUserId);
      expect(rows[0].revoked_at).toBeNull();
      // The plaintext is never stored — only its ciphertext.
      expect(rows[0].code_encrypted).not.toContain(res.body.code);
    });

    it('refuses a THIRD active code with 409 rather than retiring a note the room is using', async () => {
      const first = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      const second = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const third = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      expect(third.status).toBe(409);
      expect(third.body.code).toBe('passcode_cap_exceeded');

      const active = await sql`SELECT * FROM station_passcode WHERE revoked_at IS NULL AND expires_at > now()`;
      expect(active).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Reveal
  // -------------------------------------------------------------------------

  describe('reveal', () => {
    it('returns the same plaintext rotate minted, without rotating anything', async () => {
      const rotated = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });

      const revealed = await call('POST', `${BASE}/reveal`, { cookie: managerCookie, body: {} });

      expect(revealed.status).toBe(200);
      expect(revealed.body.passcodes.map((p) => p.code)).toEqual([rotated.body.code]);
      // Reveal exists precisely so a manager does NOT have to rotate to read
      // the code aloud: still one row, still the same one.
      const active = await sql`SELECT id FROM station_passcode WHERE revoked_at IS NULL AND expires_at > now()`;
      expect(active.map((r) => r.id)).toEqual([rotated.body.id]);
    });

    it('writes one passcode_revealed audit row per revealed code, carrying the SESSION actor id', async () => {
      const rotated = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      await call('POST', `${BASE}/reveal`, { cookie: managerCookie, body: {} });

      const audit = await attemptsWithOutcome('passcode_revealed');
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(managerUserId);
      expect(audit[0].passcode_id).toBe(rotated.body.id);
    });

    it('cannot have its actor spoofed from the request body', async () => {
      await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });

      await call('POST', `${BASE}/reveal`, {
        cookie: managerCookie,
        body: { actorUserId: 'somebody-else', userId: 'somebody-else' },
      });

      const audit = await attemptsWithOutcome('passcode_revealed');
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(managerUserId);
    });

    it('reveals both active codes and audits both', async () => {
      const first = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      const second = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });

      const revealed = await call('POST', `${BASE}/reveal`, { cookie: managerCookie, body: {} });

      expect(revealed.body.passcodes.map((p) => p.code).sort()).toEqual([first.body.code, second.body.code].sort());
      expect(await attemptsWithOutcome('passcode_revealed')).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  describe('revoke', () => {
    it("sets revoked_reason = 'manual' and takes the row out of the active set", async () => {
      const rotated = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });

      const res = await call('POST', `${BASE}/revoke`, {
        cookie: managerCookie,
        body: { passcodeId: rotated.body.id },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ passcodeId: rotated.body.id, revoked: true });

      const rows = await sql`SELECT * FROM station_passcode WHERE id = ${rotated.body.id}`;
      expect(rows[0].revoked_reason).toBe('manual');
      expect(rows[0].revoked_at).not.toBeNull();
    });

    it('is an idempotent no-op the second time, and on an unknown id', async () => {
      const rotated = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      await call('POST', `${BASE}/revoke`, { cookie: managerCookie, body: { passcodeId: rotated.body.id } });

      const again = await call('POST', `${BASE}/revoke`, {
        cookie: managerCookie,
        body: { passcodeId: rotated.body.id },
      });
      const unknown = await call('POST', `${BASE}/revoke`, { cookie: managerCookie, body: { passcodeId: 'nope' } });

      expect(again.body.revoked).toBe(false);
      expect(unknown.body.revoked).toBe(false);
    });

    it('rejects a missing passcodeId with 400', async () => {
      const res = await call('POST', `${BASE}/revoke`, { cookie: managerCookie, body: {} });
      expect(res.status).toBe(400);
    });

    it('frees a slot under the two-row cap', async () => {
      const first = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      expect((await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} })).status).toBe(409);

      await call('POST', `${BASE}/revoke`, { cookie: managerCookie, body: { passcodeId: first.body.id } });

      expect((await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} })).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Clear cooldown — the anti-lockout escape hatch
  // -------------------------------------------------------------------------

  describe('clear-cooldown', () => {
    it('lifts an ACTIVE cooldown by writing a floor row, and deletes nothing', async () => {
      await seedFailures(25);

      const before = await call('GET', `${BASE}/status`, { cookie: managerCookie });
      expect(before.body.cooldown.inCooldown).toBe(true);

      const cleared = await call('POST', `${BASE}/clear-cooldown`, { cookie: managerCookie, body: {} });
      expect(cleared.status).toBe(200);
      expect(cleared.body.cleared).toBe(true);
      expect(cleared.body.cooldown.inCooldown).toBe(false);

      const after = await call('GET', `${BASE}/status`, { cookie: managerCookie });
      expect(after.body.cooldown.inCooldown).toBe(false);
      // The floor is a floor, not a rewrite of history: every seeded failure
      // is still in the log, which is both the cooldown's input and the
      // 30-day audit trail.
      expect(await attemptsWithOutcome('passcode_fail')).toHaveLength(25);
      const clearRows = await attemptsWithOutcome('cooldown_cleared');
      expect(clearRows).toHaveLength(1);
      expect(clearRows[0].actor_user_id).toBe(managerUserId);
    });

    it('re-engages if the attack resumes after the clear — the floor is not a permanent exemption', async () => {
      await seedFailures(25);
      await call('POST', `${BASE}/clear-cooldown`, { cookie: managerCookie, body: {} });
      expect((await call('GET', `${BASE}/status`, { cookie: managerCookie })).body.cooldown.inCooldown).toBe(false);

      // Spread 0, so every resumed failure is stamped `now()` and lands
      // strictly AFTER the clear row. That is what "the attack resumes" has
      // to mean here: the clear is a floor on `attempted_at`
      // (resolveCooldownCountStart), so back-dating these behind it would be
      // testing that the floor works rather than that it expires, and would
      // leave the cooldown correctly disengaged.
      await seedFailures(25, 0);

      expect((await call('GET', `${BASE}/status`, { cookie: managerCookie })).body.cooldown.inCooldown).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  describe('status', () => {
    it('writes nothing — it is safe to poll', async () => {
      await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      const attemptsBefore = await sql`SELECT count(*)::int AS c FROM station_signup_attempt`;

      await call('GET', `${BASE}/status`, { cookie: managerCookie });
      await call('GET', `${BASE}/status`, { cookie: managerCookie });

      const attemptsAfter = await sql`SELECT count(*)::int AS c FROM station_signup_attempt`;
      expect(attemptsAfter[0].c).toBe(attemptsBefore[0].c);
    });

    it('reports active-code state with use_count/max_uses and last_used_at, and never any plaintext', async () => {
      const rotated = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });

      const res = await call('GET', `${BASE}/status`, { cookie: managerCookie });

      expect(res.status).toBe(200);
      const row = res.body.passcodes.find((p) => p.id === rotated.body.id);
      expect(row).toMatchObject({
        state: 'active',
        useCount: 0,
        maxUses: 25,
        lastUsedAt: null,
        exhausted: false,
        revokedByKeyRotation: false,
      });
      expect(JSON.stringify(res.body)).not.toContain(rotated.body.code);
      expect(row.codeEncrypted).toBeUndefined();
    });

    it('reports a revoked row with its reason, and an expired row as expired', async () => {
      const revoked = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      await call('POST', `${BASE}/revoke`, { cookie: managerCookie, body: { passcodeId: revoked.body.id } });

      const expiredId = `${uniqueId()}-exp`;
      await sql`
        INSERT INTO station_passcode (id, code_encrypted, expires_at)
        VALUES (${expiredId}, 'not-a-real-ciphertext', now() - interval '1 hour')
      `;

      const res = await call('GET', `${BASE}/status`, { cookie: managerCookie });
      const byId = Object.fromEntries(res.body.passcodes.map((p) => [p.id, p]));

      expect(byId[revoked.body.id]).toMatchObject({ state: 'revoked', revokedReason: 'manual' });
      expect(byId[expiredId]).toMatchObject({ state: 'expired' });
    });

    it('flags an exhausted row, which is still "active" by the SQL predicate', async () => {
      const rotated = await call('POST', `${BASE}/rotate`, { cookie: managerCookie, body: {} });
      await sql`UPDATE station_passcode SET use_count = max_uses, last_used_at = now() WHERE id = ${rotated.body.id}`;

      const res = await call('GET', `${BASE}/status`, { cookie: managerCookie });
      const row = res.body.passcodes.find((p) => p.id === rotated.body.id);

      expect(row.state).toBe('active');
      expect(row.exhausted).toBe(true);
      expect(row.lastUsedAt).not.toBeNull();
    });

    it('reports the failure counts, the rule they are measured against, and the recent attempts', async () => {
      await seedFailures(3, 60);
      await sql`
        INSERT INTO station_signup_attempt (id, attempted_at, outcome)
        VALUES (${`${uniqueId()}-x`}, now(), 'passcode_expired')
      `;

      const res = await call('GET', `${BASE}/status`, { cookie: managerCookie });

      expect(res.body.cooldown).toMatchObject({
        inCooldown: false,
        noMatchFailureCount: 3,
        allFailureCount: 4,
        windowMinutes: 10,
        holdMinutes: 15,
        threshold: 20,
      });
      expect(res.body.attempts.countsByOutcome).toMatchObject({ passcode_fail: 3, passcode_expired: 1 });
      expect(res.body.attempts.recent).toHaveLength(4);
    });

    it('lists pending accounts with their days-pending and self_signup_downgraded_at', async () => {
      const fresh = await seedAccount({ daysPending: 2, memberRole: 'dj' });
      const overdue = await seedAccount({ daysPending: 40, memberRole: 'member', downgraded: true });

      const res = await call('GET', `${BASE}/status`, { cookie: managerCookie });
      const byId = Object.fromEntries(res.body.pendingReview.map((p) => [p.userId, p]));

      expect(byId[fresh]).toMatchObject({ daysPending: 2, selfSignupDowngradedAt: null });
      expect(byId[overdue].daysPending).toBe(40);
      expect(byId[overdue].selfSignupDowngradedAt).not.toBeNull();
      // PII stays off this payload: the derived display name is here, the
      // legal name and the email are not.
      expect(byId[fresh].name).toBe('SSA Test DJ');
      expect(byId[fresh].email).toBeUndefined();
      expect(byId[fresh].realName).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Approve
  // -------------------------------------------------------------------------

  describe('approve', () => {
    it('stamps reviewed_at/_by from the SESSION, and refuses a client-supplied reviewer', async () => {
      const userId = await seedAccount({ daysPending: 5, memberRole: 'dj' });

      const res = await call('POST', `${BASE}/approve`, {
        cookie: managerCookie,
        body: { userId, reviewerId: 'somebody-else', selfSignupReviewedBy: 'somebody-else' },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userId, reviewedByThisCall: true, roleRestored: false, memberRole: 'dj' });

      const row = await authUserRowOf(userId);
      expect(row.self_signup_reviewed_at).not.toBeNull();
      // The acting manager, never the body — this is what retires dj-site#1358's
      // any-manager attribution residual.
      expect(row.self_signup_reviewed_by).toBe(managerUserId);
    });

    it('takes the account out of the pending cohort the digest and dj-site both read', async () => {
      const userId = await seedAccount({ daysPending: 5, memberRole: 'dj' });
      expect((await queryPendingSelfSignups()).map((r) => r.userId)).toContain(userId);

      await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId } });

      expect((await queryPendingSelfSignups()).map((r) => r.userId)).not.toContain(userId);
    });

    describe('against an account the actuator already downgraded', () => {
      it('WITHOUT restoreDjRole leaves it a member, and PRESERVES the downgrade marker', async () => {
        const userId = await seedAccount({ daysPending: 40, memberRole: 'member', downgraded: true });
        const markerBefore = (await authUserRowOf(userId)).self_signup_downgraded_at;

        const res = await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId } });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ roleRestored: false, memberRole: 'member' });
        expect(res.body.selfSignupDowngradedAt).not.toBeNull();
        // Reviewing is not a history edit; the marker records what happened.
        expect((await authUserRowOf(userId)).self_signup_downgraded_at).toEqual(markerBefore);
        expect(await memberRoleOf(userId)).toBe('member');
      });

      it('WITH restoreDjRole hands the dj role back, and STILL preserves the marker', async () => {
        const userId = await seedAccount({ daysPending: 40, memberRole: 'member', downgraded: true });
        const markerBefore = (await authUserRowOf(userId)).self_signup_downgraded_at;

        const res = await call('POST', `${BASE}/approve`, {
          cookie: managerCookie,
          body: { userId, restoreDjRole: true },
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ roleRestored: true, memberRole: 'dj' });
        expect(await memberRoleOf(userId)).toBe('dj');
        expect((await authUserRowOf(userId)).self_signup_downgraded_at).toEqual(markerBefore);
        // And the re-promotion sticks, because the marker took the account out
        // of the actuator for good.
        expect((await authUserRowOf(userId)).role).toBe('user');
      });

      it('a re-promotion approved this way is not undone by the next actuator run', async () => {
        const userId = await seedAccount({ daysPending: 40, memberRole: 'member', downgraded: true });
        await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId, restoreDjRole: true } });

        const pending = (await queryPendingSelfSignups()).filter((r) => r.userId === userId);
        const decisions = await planDowngrades(db, pending, new Date());
        await applyDowngrades(db, decisions, new Date());

        expect(await memberRoleOf(userId)).toBe('dj');
      });
    });

    it('cannot grant any role but dj — a musicDirector is left alone, never demoted', async () => {
      const userId = await seedAccount({ daysPending: 5, memberRole: 'musicDirector' });

      const res = await call('POST', `${BASE}/approve`, {
        cookie: managerCookie,
        body: { userId, restoreDjRole: true },
      });

      expect(res.body.roleRestored).toBe(false);
      expect(await memberRoleOf(userId)).toBe('musicDirector');
    });

    it('is write-once on the review stamp: a second manager cannot re-attribute the review', async () => {
      const userId = await seedAccount({ daysPending: 5, memberRole: 'dj' });
      await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId } });
      const first = await authUserRowOf(userId);

      const second = await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId } });

      expect(second.body.reviewedByThisCall).toBe(false);
      const after = await authUserRowOf(userId);
      expect(after.self_signup_reviewed_at).toEqual(first.self_signup_reviewed_at);
      expect(after.self_signup_reviewed_by).toBe(managerUserId);
    });

    it('still applies restoreDjRole on that second call', async () => {
      const userId = await seedAccount({ daysPending: 40, memberRole: 'member', downgraded: true });
      await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId } });

      const res = await call('POST', `${BASE}/approve`, {
        cookie: managerCookie,
        body: { userId, restoreDjRole: true },
      });

      expect(res.body).toMatchObject({ reviewedByThisCall: false, roleRestored: true, memberRole: 'dj' });
    });

    it('404s on an unknown user and 409s on an account that never self-signed up', async () => {
      const notASignup = await seedAccount({ selfSignup: false, memberRole: 'dj' });

      expect((await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId: 'nope' } })).status).toBe(
        404
      );
      const conflict = await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId: notASignup } });
      expect(conflict.status).toBe(409);
      expect((await authUserRowOf(notASignup)).self_signup_reviewed_at).toBeNull();
    });

    it('rejects a missing userId with 400 and a non-boolean restoreDjRole with 400', async () => {
      expect((await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: {} })).status).toBe(400);
      const userId = await seedAccount({ daysPending: 5 });
      expect(
        (await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId, restoreDjRole: 'yes' } }))
          .status
      ).toBe(400);
      expect((await authUserRowOf(userId)).self_signup_reviewed_at).toBeNull();
    });

    // -----------------------------------------------------------------------
    // The race the shared lock order exists for
    // -----------------------------------------------------------------------

    it('approve-then-downgrade: the actuator aborts into `raced` and writes nothing', async () => {
      const userId = await seedAccount({ daysPending: 40, memberRole: 'dj' });

      // Plan while the account is still pending — this is the job's own
      // snapshot, taken minutes before it writes (the SES round trip sits in
      // between).
      const pending = (await queryPendingSelfSignups()).filter((r) => r.userId === userId);
      const decisions = await planDowngrades(db, pending, new Date());
      expect(decisions[0].status).toBe('downgraded');

      // The manager approves inside that window.
      const approved = await call('POST', `${BASE}/approve`, { cookie: managerCookie, body: { userId } });
      expect(approved.status).toBe(200);

      // `applyDowngrades` re-selects FOR UPDATE and finds the review committed.
      const applied = await applyDowngrades(db, decisions, new Date());

      expect(applied.downgraded).toEqual([]);
      expect(applied.failed).toEqual([]);
      expect(applied.raced.map((r) => r.userId)).toEqual([userId]);
      // Neither half of the actuator's paired write landed.
      expect(await memberRoleOf(userId)).toBe('dj');
      expect((await authUserRowOf(userId)).self_signup_downgraded_at).toBeNull();
    });

    it('downgrade-then-approve: the account arrives as a member, and restoreDjRole is what fixes it', async () => {
      const userId = await seedAccount({ daysPending: 40, memberRole: 'dj' });

      const pending = (await queryPendingSelfSignups()).filter((r) => r.userId === userId);
      const decisions = await planDowngrades(db, pending, new Date());
      const applied = await applyDowngrades(db, decisions, new Date());
      expect(applied.downgraded.map((r) => r.userId)).toEqual([userId]);
      expect(await memberRoleOf(userId)).toBe('member');

      const res = await call('POST', `${BASE}/approve`, {
        cookie: managerCookie,
        body: { userId, restoreDjRole: true },
      });

      expect(res.body).toMatchObject({ roleRestored: true, memberRole: 'dj' });
      expect(res.body.selfSignupDowngradedAt).not.toBeNull();
    });
  });
});
