const get_access_token = require('../utils/better_auth');
const postgres = require('postgres');

// Ensure mock services are enabled for testing
process.env.NODE_ENV = 'test';
process.env.USE_MOCK_SERVICES = 'true';
// This only affects the jest test-runner process, not the separately
// spawned auth/backend servers the integration suite talks to over HTTP —
// those get EMAIL_ENABLED=false from ci-env.sh / test.yml's "Start
// services" step. Set here too for parity with any in-process helper that
// imports shared/authentication directly.
process.env.EMAIL_ENABLED = process.env.EMAIL_ENABLED ?? 'false';

global.primary_dj_id = null;
global.secondary_dj_id = null;
global.access_token = '';
// Secondary DJ's token. Populated as `Bearer <secondary_dj_id>` — a raw
// user-id Bearer that AUTH_BYPASS accepts via auth.middleware.ts's catch
// branch (no JWT parse, req.auth.id = token). Used by integration tests
// that need to act AS the secondary DJ (e.g. /flowsheet/join with the
// secondary's id) under the BS#1098 / BS#1102 dj_id=auth.id cross-check.
global.secondary_access_token = '';

// DB config with defaults to avoid connecting as root when envs are missing
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'wxyc_db',
  username: process.env.DB_USERNAME || 'test-user',
  password: process.env.DB_PASSWORD || 'test-pw',
};

async function getUserIdsFromDatabase() {
  const sql = postgres({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.username,
    password: dbConfig.password,
  });

  try {
    const primaryUser = await sql`
      SELECT id FROM auth_user WHERE username = 'test_dj1' LIMIT 1
    `;
    const secondaryUser = await sql`
      SELECT id FROM auth_user WHERE username = 'test_dj2' LIMIT 1
    `;

    if (primaryUser.length === 0 || secondaryUser.length === 0) {
      throw new Error('Test users (test_dj1, test_dj2) not found in database. Ensure seed data is loaded.');
    }

    global.primary_dj_id = primaryUser[0].id;
    global.secondary_dj_id = secondaryUser[0].id;
  } finally {
    await sql.end();
  }
}

// Note: Service readiness is checked in globalSetup.js (runs once for all tests)
beforeAll(async () => {
  await getUserIdsFromDatabase();
  const token = await get_access_token();
  global.access_token = `Bearer ${token}`;
  // AUTH_BYPASS accepts a raw user-id Bearer when the token doesn't parse as
  // a JWT, populating `req.auth.id` from the token value (see
  // shared/authentication/src/auth.middleware.ts catch branch). That gives
  // us a per-DJ identity without needing a second better-auth sign-in.
  global.secondary_access_token = `Bearer ${global.secondary_dj_id}`;
});
