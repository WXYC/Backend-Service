const get_access_token = require('./utils/better_auth');
const postgres = require('postgres');

global.primary_dj_id = null;
global.secondary_dj_id = null;
global.access_token = '';

async function getUserIdsFromDatabase() {
  // Connect to database to get user IDs
  // Prioritize CI_DB_PORT for CI environments, then DB_PORT, then default
  const dbPort = process.env.CI_DB_PORT 
    ? parseInt(process.env.CI_DB_PORT) 
    : (process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432);
  
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
    
    console.log(`Test user IDs loaded: primary=${global.primary_dj_id}, secondary=${global.secondary_dj_id}`);
  } catch (err) {
    throw err;
  } finally {
    await sql.end();
  }
}

/**
 * Simple healthcheck polling function to replace wait-on
 * Polls HTTP endpoints until they return 200 OK or timeout is reached
 */
async function waitForServices(resources, options = {}) {
  const {
    delay = 1000,
    interval = 500,
    timeout = 60000,
    httpTimeout = 2000,
  } = options;

  const startTime = Date.now();

  // Initial delay
  await new Promise(resolve => setTimeout(resolve, delay));

  while (Date.now() - startTime < timeout) {
    const results = await Promise.allSettled(
      resources.map(url => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), httpTimeout);
        
        return fetch(url, {
          method: 'GET',
          signal: controller.signal,
        })
          .then(res => {
            clearTimeout(timeoutId);
            if (res.ok) {
              return { url, status: 'ready' };
            }
            return { url, status: 'not-ready', statusCode: res.status };
          })
          .catch(err => {
            clearTimeout(timeoutId);
            return { url, status: 'not-ready', error: err.message };
          });
      })
    );

    const allReady = results.every(result => 
      result.status === 'fulfilled' && result.value.status === 'ready'
    );

    if (allReady) {
      console.log('Services are ready!');
      return;
    }

    // Log progress for first few attempts
    if ((Date.now() - startTime) % (interval * 10) < interval) {
      const readyCount = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 'ready'
      ).length;
      console.log(`Waiting for services... (${readyCount}/${resources.length} ready)`);
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for services to be ready after ${timeout}ms`);
}

beforeAll(async () => {
  // Determine the healthcheck URLs dynamically
  const backendHealthcheckUrl = `http://localhost:${process.env.PORT}/healthcheck`;
  const authBaseUrl = new URL(process.env.BETTER_AUTH_URL).origin;
  const authHealthcheckUrl = `${authBaseUrl}/healthcheck`;

  const resources = [backendHealthcheckUrl, authHealthcheckUrl];

  console.log(`Waiting for services to be ready: ${resources.join(', ')}`);
  try {
    await waitForServices(resources, {
      delay: 1000,
      interval: 500,
      timeout: 60000,
      httpTimeout: 2000,
    });
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
