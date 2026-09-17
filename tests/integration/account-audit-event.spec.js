/**
 * Integration tests for the account-audit decorator (BS#2537, parent epic
 * #2534), driven against the live CI auth service — the
 * `admin-create-user-email-verify.spec.js` / `device-authorization.spec.js`
 * idiom, not the job-style `station-signup-review.spec.js`, which drives a
 * job by importing built `dist`.
 *
 * The audit write is fire-and-forget after `res.on('finish')`, so the HTTP
 * response can return before the INSERT commits — every row assertion below
 * short-polls (the `waitForMetadata` idiom in `tests/utils/metadata_util.js`)
 * rather than reading immediately.
 *
 * Simplify pass (code review BS#2537 PR #2545 follow-up, item 19): the DB
 * connection now goes through the shared `getTestDb()` pool
 * (`tests/utils/db.js`), the same one `auth-log-prune.spec.js` uses,
 * instead of a private single-use `postgres()` client; `getAuthBaseUrl` +
 * `signInAsStationManager` moved to `tests/utils/account_audit_auth.js`,
 * consumed only by this spec (see that module's header for why the eight
 * other legacy specs carrying their own `getAuthBaseUrl` copy are a
 * separate follow-up).
 */

const { getTestDb } = require('../utils/db');
const { getAuthBaseUrl, signInAsStationManager } = require('../utils/account_audit_auth');

async function waitForAuditRow(sql, whereSql, params, maxWaitMs = 5000, pollIntervalMs = 250) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const rows = await sql.unsafe(
      `SELECT * FROM account_audit_event WHERE ${whereSql} ORDER BY occurred_at DESC LIMIT 1`,
      params
    );
    if (rows.length > 0) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

describe('account_audit_event (BS#2537)', () => {
  const authBaseUrl = getAuthBaseUrl();
  let sql;
  let cookie;
  let managerId;
  /** @type {string[]} user ids created by these tests; deleted in afterEach. */
  const createdUserIds = [];

  beforeAll(async () => {
    sql = getTestDb();
    ({ cookie, managerId } = await signInAsStationManager(authBaseUrl));
  });

  afterEach(async () => {
    if (createdUserIds.length === 0) return;
    await sql.unsafe(`DELETE FROM auth_user WHERE id = ANY(${'$1'}::text[])`, [createdUserIds.splice(0)]);
  });

  test('an admin-prefix mutation records the signed-in manager as actor', async () => {
    const email = `audit-actor-${Date.now()}@test.wxyc.org`;
    const res = await fetch(`${authBaseUrl}/admin/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, password: 'testpassword123', name: 'Audit Actor Test', role: 'user' }),
    });
    if (!res.ok) {
      throw new Error(`create-user failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    createdUserIds.push(body.user.id);

    const row = await waitForAuditRow(
      sql,
      `action = $1 AND actor_user_id = $2 AND occurred_at > now() - interval '1 minute'`,
      ['admin.create-user', managerId]
    );
    expect(row).toBeTruthy();
    expect(row.outcome).toBe(200);
    expect(row.source).toBe('http');
  });

  test('forget-password resolves the subject by email and never persists the email', async () => {
    const email = `audit-forget-password-${Date.now()}@test.wxyc.org`;
    const createRes = await fetch(`${authBaseUrl}/admin/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, password: 'testpassword123', name: 'Audit Subject Test', role: 'user' }),
    });
    if (!createRes.ok) {
      throw new Error(`create-user failed: ${createRes.status} ${await createRes.text()}`);
    }
    const createdUserId = (await createRes.json()).user.id;
    createdUserIds.push(createdUserId);

    const resetRes = await fetch(`${authBaseUrl}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, redirectTo: 'https://dj.wxyc.org/reset-password' }),
    });
    if (!resetRes.ok) {
      throw new Error(`request-password-reset failed: ${resetRes.status} ${await resetRes.text()}`);
    }

    const row = await waitForAuditRow(sql, `action = $1 AND subject_user_id = $2`, ['forget-password', createdUserId]);
    expect(row).toBeTruthy();
    expect(row.actor_user_id).toBeNull();
    expect(row.outcome).toBe(200);
    // AC#3: the submitted email string must appear nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(email);
  });
});
