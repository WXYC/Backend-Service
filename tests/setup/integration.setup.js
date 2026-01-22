const get_access_token = require('../utils/better_auth');
const waitOn = require('wait-on');
const postgres = require('postgres');

global.primary_dj_id = null;
global.secondary_dj_id = null;
global.access_token = '';

async function getUserIdsFromDatabase() {
  // Connect to database to get user IDs
  // Prioritize CI_DB_PORT for CI environments, then DB_PORT, then default
  const dbPort = process.env.DB_PORT || 5432;

  const sql = postgres({
    host: process.env.DB_HOST || 'localhost',
    port: dbPort,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });

  try {
    // Get user IDs by username
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
  } catch (err) {
    throw err;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  // Determine the healthcheck URLs dynamically
  const backendHealthcheckUrl = `http://localhost:${process.env.PORT}/healthcheck`;
  const authBaseUrl = new URL(process.env.BETTER_AUTH_URL).origin;
  const authHealthcheckUrl = `${authBaseUrl}/healthcheck`;

  const waitOnOptions = {
    resources: [backendHealthcheckUrl, authHealthcheckUrl],
    delay: 500, // initial delay in ms (reduced from 1000)
    interval: 250, // poll interval in ms (reduced from 500)
    timeout: 15000, // timeout in ms (reduced from 60000 - services should start fast in CI)
    tcpTimeout: 500, // tcp timeout in ms (reduced from 1000)
    httpTimeout: 1000, // http timeout in ms (reduced from 2000)
    log: true, // Log wait-on progress
  };

  console.log(`Waiting for services to be ready: ${waitOnOptions.resources.join(', ')}`);
  try {
    await waitOn(waitOnOptions);
    console.log('Services are ready!');
  } catch (err) {
    console.error('Error waiting for services:', err);
    throw err; // Fail the test suite if services are not ready
  }

  // Load user IDs from database
  // Note: Database is already ready at this point due to Docker Compose orchestration
  await getUserIdsFromDatabase();

  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
  } else {
    global.access_token = await get_access_token();
  }
});
