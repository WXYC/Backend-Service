const get_access_token = require('../utils/better_auth');
const waitOn = require('wait-on');
const postgres = require('postgres');

global.primary_dj_id = null;
global.secondary_dj_id = null;
global.access_token = '';

// Sensible defaults for ports/hosts used in CI
const backendHost = process.env.BACKEND_HOST || 'localhost';
const backendPort = process.env.PORT || process.env.BACKEND_PORT || process.env.CI_PORT || 8081;
const backendHealthcheckUrl = `http://${backendHost}:${backendPort}/healthcheck`;

// BETTER_AUTH_URL may be a full URL; if not present, fall back to AUTH_HOST/AUTH_PORT
let authBaseUrl;
if (process.env.BETTER_AUTH_URL) {
  try {
    authBaseUrl = new URL(process.env.BETTER_AUTH_URL).origin;
  } catch (err) {
    console.warn('Malformed BETTER_AUTH_URL, falling back to AUTH_HOST/AUTH_PORT');
    authBaseUrl = `http://${process.env.AUTH_HOST || 'localhost'}:${process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083}`;
  }
} else {
  authBaseUrl = `http://${process.env.AUTH_HOST || 'localhost'}:${process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083}`;
}
const authHealthcheckUrl = `${authBaseUrl}/healthcheck`;

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

beforeAll(async () => {
  // Log resolved endpoints/DB config to make CI failures easier to debug
  console.log('Resolved healthcheck URLs:', backendHealthcheckUrl, authHealthcheckUrl);
  console.log('Resolved DB config:', {
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    username: dbConfig.username ? '***' : '(none)',
  });

  const waitOnOptions = {
    resources: [backendHealthcheckUrl, authHealthcheckUrl],
    delay: 1000,
    interval: 500,
    timeout: 60000,
    tcpTimeout: 1000,
    httpTimeout: 2000,
    log: true,
  };

  console.log(`Waiting for services to be ready: ${waitOnOptions.resources.join(', ')}`);
  try {
    await waitOn(waitOnOptions);
    console.log('Services are ready!');
  } catch (err) {
    console.error('Error waiting for services:', err);
    throw err;
  }

  await getUserIdsFromDatabase();

  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
  } else {
    global.access_token = await get_access_token();
  }
});
