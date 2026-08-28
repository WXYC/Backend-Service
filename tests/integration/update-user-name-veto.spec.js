/**
 * Wire spec for the `update.before` name veto (DJ real-name PII safeguards
 * plan, Track 2b) against the real better-auth `POST /update-user` endpoint.
 *
 * Exists because the endpoint's adapter payload is always `{ name, image,
 * ...additionalFields }` (api/routes/update-user.mjs) — the `name` key is
 * present on EVERY call, `undefined` when the client didn't send one. The
 * hook's unit tests exercise the hook with payloads the test author shapes;
 * only a wire test proves the hook against the payload better-auth actually
 * builds. The original key-presence veto passed its unit suite while
 * aborting every public profile update in production (dj-site's
 * `updateUser({ appSkin })` experience switch was the observable failure).
 *
 * A vetoed write is SILENT at the HTTP layer: `updateWithHooks` returns null
 * and the route falls back to echoing session data with `{ status: true }`,
 * so every assertion here is against the database row, never the response.
 *
 * Follows auth-auto-membership.spec.js's sign-in/cookie/postgres pattern.
 */

const postgres = require('postgres');

// Structurally non-PII probe values — sentinel-shaped, never a real name.
const NAME_PROBE = 'VETO-PROBE-NAME-93aF';
const APPSKIN_PROBE = 'veto-probe-appskin-93af';
const APPSKIN_PROBE_2 = 'veto-probe-appskin-93af-second';

const USERNAME = 'test_station_manager';
const PASSWORD = 'testpassword123';

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

describe('POST /update-user name veto (DJ real-name PII safeguards plan, Track 2b)', () => {
  const authBaseUrl = getAuthBaseUrl();
  const frontendUrl = process.env.FRONTEND_SOURCE || 'http://localhost:3000';
  let sql;
  let cookie;
  let userId;
  let originalAppSkin;
  let originalName;

  async function fetchRow() {
    const rows = await sql`SELECT id, name, app_skin FROM auth_user WHERE username = ${USERNAME}`;
    if (rows.length !== 1) {
      throw new Error(`expected exactly one ${USERNAME} row, got ${rows.length}`);
    }
    return rows[0];
  }

  async function postUpdateUser(body) {
    const res = await fetch(`${authBaseUrl}/update-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: frontendUrl,
        cookie,
      },
      body: JSON.stringify(body),
    });
    return res;
  }

  beforeAll(async () => {
    sql = makeSql();

    const res = await fetch(`${authBaseUrl}/sign-in/username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: frontendUrl },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    if (!res.ok) {
      throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
    }
    const cookies = res.headers.getSetCookie();
    if (!cookies || cookies.length === 0) {
      throw new Error('No session cookie returned by sign-in');
    }
    cookie = cookies.map((c) => c.split(';')[0].trim()).join('; ');

    const row = await fetchRow();
    userId = row.id;
    originalAppSkin = row.app_skin;
    originalName = row.name;
  });

  afterAll(async () => {
    // Surgical restore of only what this spec may have changed.
    if (sql && userId !== undefined && originalAppSkin !== undefined) {
      await sql`UPDATE auth_user SET app_skin = ${originalAppSkin} WHERE id = ${userId}`;
    }
    if (sql) await sql.end();
  });

  it('persists an unrelated-field update (the appSkin experience switch) despite the endpoint-injected undefined name', async () => {
    const res = await postUpdateUser({ appSkin: APPSKIN_PROBE });
    expect(res.ok).toBe(true);

    const row = await fetchRow();
    expect(row.app_skin).toBe(APPSKIN_PROBE);
    // The injected `name: undefined` must not have touched name either.
    expect(row.name).toBe(originalName);
  });

  it('aborts the entire write when the payload supplies a name — sibling fields do not land', async () => {
    const res = await postUpdateUser({ name: NAME_PROBE, appSkin: APPSKIN_PROBE_2 });
    // The veto is silent at the HTTP layer (see file docblock) — the row is
    // the only honest witness.
    expect(res.status).toBeLessThan(500);

    const row = await fetchRow();
    expect(row.name).toBe(originalName);
    expect(row.app_skin).toBe(APPSKIN_PROBE);
  });

  it('aborts a bare name-only write', async () => {
    const res = await postUpdateUser({ name: NAME_PROBE });
    expect(res.status).toBeLessThan(500);

    const row = await fetchRow();
    expect(row.name).toBe(originalName);
  });
});
