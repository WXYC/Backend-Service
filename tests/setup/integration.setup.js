const get_access_token = require('../utils/better_auth');
const postgres = require('postgres');

// Ensure mock services are enabled for testing
process.env.NODE_ENV = 'test';
process.env.USE_MOCK_SERVICES = 'true';

global.primary_dj_id = null;
global.secondary_dj_id = null;
global.access_token = '';

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

  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
  } else {
    global.access_token = await get_access_token();
  }
});
