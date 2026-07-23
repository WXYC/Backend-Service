/**
 * Integration tests for the `/admin/create-user` after-hook in
 * `shared/authentication/src/auth.definition.ts` that auto-verifies
 * admin-created users (BS#1118).
 *
 * The hook used to key its `UPDATE auth_user SET email_verified = true`
 * off the request-body email (`WHERE email = ctx.body.email`) rather than
 * the id of the user the endpoint just created. The endpoint's own handler
 * lowercases `ctx.body.email` before storing/looking it up, but the hook
 * compared against the *original*, unlowered value. When a case-variant
 * row for the same email already exists (e.g. from a legacy import or a
 * different write path), the endpoint doesn't detect it as a collision
 * (its own duplicate check is case-sensitive against whatever is already
 * on disk) and creates a second row — but the after-hook's email-keyed
 * UPDATE then matches the *pre-existing* case-variant row instead of the
 * row it just created, silently leaving the new user unverified while
 * flipping an unrelated account.
 *
 * These tests seed that pre-existing case-variant row directly via SQL,
 * then drive the real endpoint, and assert the fix (keying the UPDATE off
 * the created user's id from `ctx.context.returned`) attributes the flip
 * to the correct row only.
 */

const postgres = require('postgres');

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

async function signInAsStationManager(authBaseUrl) {
  const res = await fetch(`${authBaseUrl}/sign-in/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_station_manager', password: 'testpassword123' }),
  });
  if (!res.ok) {
    throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie();
  if (!cookies || cookies.length === 0) {
    throw new Error('No session cookie returned by sign-in');
  }
  return cookies.map((c) => c.split(';')[0].trim()).join('; ');
}

describe('/admin/create-user email-verify after-hook', () => {
  const authBaseUrl = getAuthBaseUrl();
  let sql;
  let cookie;
  /** @type {string[]} user ids created by these tests; deleted in afterEach. */
  const createdUserIds = [];

  beforeAll(async () => {
    sql = makeSql();
    cookie = await signInAsStationManager(authBaseUrl);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    if (createdUserIds.length === 0) return;
    await sql.unsafe(`DELETE FROM auth_user WHERE id = ANY(${'$1'}::text[])`, [createdUserIds.splice(0)]);
  });

  test('flips only the newly created row, even when a case-variant row already exists', async () => {
    const stamp = Date.now();
    const mixedCaseEmail = `CaseTest${stamp}@Test.wxyc.org`;
    const lowerCaseEmail = mixedCaseEmail.toLowerCase();

    // Seed a pre-existing, unverified row with a case-variant of the email
    // the admin endpoint will be asked to create. This simulates a row
    // written by a path that didn't normalize casing (legacy import, direct
    // SQL, etc.) — the endpoint's own duplicate check is case-sensitive
    // against whatever is already on disk, so it won't detect this as a
    // collision.
    const decoyId = `decoy-${stamp}`;
    await sql.unsafe(
      `INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, false, now(), now())`,
      [decoyId, 'Decoy Pre-existing User', mixedCaseEmail]
    );
    createdUserIds.push(decoyId);

    // Submit the *original* mixed-case email in the request body. The
    // endpoint's handler lowercases it before creating/storing the new row,
    // so the new row's stored email is `lowerCaseEmail`, distinct from the
    // decoy's stored `mixedCaseEmail`.
    const res = await fetch(`${authBaseUrl}/admin/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        email: mixedCaseEmail,
        password: 'testpassword123',
        name: 'Case Collision Test',
        role: 'user',
      }),
    });
    if (!res.ok) {
      throw new Error(`create-user failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    expect(body?.user?.id).toBeTruthy();
    const newUserId = body.user.id;
    createdUserIds.push(newUserId);

    const rows = await sql.unsafe(`SELECT id, email, email_verified FROM auth_user WHERE id = ANY($1::text[])`, [
      [decoyId, newUserId],
    ]);
    const newRow = rows.find((r) => r.id === newUserId);
    const decoyRow = rows.find((r) => r.id === decoyId);

    expect(newRow).toBeTruthy();
    expect(newRow.email).toBe(lowerCaseEmail);
    expect(newRow.email_verified).toBe(true);

    // The pre-existing case-variant row must be untouched by this admin
    // action — it was never the user being created.
    expect(decoyRow).toBeTruthy();
    expect(decoyRow.email).toBe(mixedCaseEmail);
    expect(decoyRow.email_verified).toBe(false);
  });

  test('bare POST /admin/create-user auto-verifies the created user by id', async () => {
    const email = `auto-verify-${Date.now()}@test.wxyc.org`;
    const res = await fetch(`${authBaseUrl}/admin/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        email,
        password: 'testpassword123',
        name: 'Auto Verify Test',
        role: 'user',
      }),
    });
    if (!res.ok) {
      throw new Error(`create-user failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    expect(body?.user?.id).toBeTruthy();
    const userId = body.user.id;
    createdUserIds.push(userId);

    const rows = await sql.unsafe(`SELECT email_verified FROM auth_user WHERE id = $1`, [userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email_verified).toBe(true);
  });
});
