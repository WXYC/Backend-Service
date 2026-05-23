/**
 * Integration tests for the `databaseHooks.user.create.after` hook in
 * `shared/authentication/src/auth.definition.ts`.
 *
 * The hook is the safety net that ensures every non-anonymous newly created
 * user gets an `auth_member` row in the default organization. Without it,
 * users created via better-auth's bare `POST /admin/create-user` endpoint
 * land in `auth_user` with no membership and trigger a FORBIDDEN on
 * `organization.listMembers` — the bug that prompted these changes.
 *
 * What's covered here:
 *   1. Bare admin create-user path: the new user gets a member row with
 *      role=`member`. This is the path that broke before.
 *   2. provisionUser path: the new user gets a member row with the
 *      requested role. Proves the upsert refactor in provision-user.ts
 *      cooperates with the auto-membership hook (the hook fires first
 *      and inserts role=`member`; provisionUser then upserts to the
 *      requested role).
 *
 * Anonymous-plugin sign-ins are covered by the comment in the hook itself
 * — exercising them here would also need a publicly reachable anonymous
 * sign-in endpoint and adds little signal over the unit tests.
 */

const postgres = require('postgres');

// `auth_*` tables live in the default `public` schema (not the WXYC
// `wxyc_schema` that holds the domain tables — see schema.ts where
// `user`, `member`, `organization` are pgTable() without a wxyc_schema
// prefix).
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

/**
 * Sign in as test_station_manager and return the Cookie header value to
 * send on subsequent admin-plugin requests. Admin endpoints authenticate
 * via the better-auth session cookie, not the JWT used elsewhere in the
 * integration suite.
 */
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

describe('user.create.after auto-membership hook', () => {
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
    // FK on auth_member cascades to auth_user, so removing the user removes
    // the member row too. We use raw SQL rather than DELETE /admin/remove-user
    // to keep cleanup independent of the endpoint under test.
    await sql.unsafe(`DELETE FROM auth_user WHERE id = ANY(${'$1'}::text[])`, [createdUserIds.splice(0)]);
  });

  test('bare POST /admin/create-user auto-creates an auth_member row with role=member', async () => {
    const email = `auto-member-${Date.now()}@test.wxyc.org`;
    const res = await fetch(`${authBaseUrl}/admin/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        email,
        password: 'testpassword123',
        name: 'Auto Member Test',
        // Bare admin endpoint accepts 'admin'/'user' for the auth_user.role
        // field. We pass 'user' here so the test exercises the case the
        // hook was added to repair (non-station-manager user with no
        // org membership).
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

    // The hook runs in the `after` phase of internalAdapter.createUser, so
    // by the time the HTTP response returns the member row is committed.
    const memberRows = await sql.unsafe(
      `SELECT m.id, m.role, o.slug
         FROM auth_member m
         JOIN auth_organization o ON o.id = m.organization_id
        WHERE m.user_id = $1`,
      [userId]
    );
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].role).toBe('member');
    expect(memberRows[0].slug).toBe(ORG_SLUG);
  });

  test('POST /admin/provision-user upserts the auto-created member row to the requested role', async () => {
    const email = `provision-upsert-${Date.now()}@test.wxyc.org`;
    const username = `prov_upsert_${Date.now()}`;
    const res = await fetch(`${authBaseUrl}/admin/provision-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        email,
        username,
        password: 'testpassword123',
        name: 'Provision Upsert Test',
        organizationSlug: ORG_SLUG,
        role: 'dj',
      }),
    });
    if (!res.ok) {
      throw new Error(`provision-user failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    expect(body?.user?.id).toBeTruthy();
    const userId = body.user.id;
    createdUserIds.push(userId);

    // Exactly one member row, with the requested role rather than the
    // hook's default `member`. Confirms provisionUser's upsert overwrote
    // the row the hook auto-created (rather than racing and crashing on
    // the unique (organization_id, user_id) constraint).
    const memberRows = await sql.unsafe(`SELECT role FROM auth_member WHERE user_id = $1`, [userId]);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].role).toBe('dj');
  });
});
