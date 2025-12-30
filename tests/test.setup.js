const get_access_token = require('./utils/better_auth');
const waitOn = require('wait-on'); // Import wait-on

global.primary_dj_id = 1;
global.secondary_dj_id = 2;
global.access_token = '';

beforeAll(async () => {
  // Determine the healthcheck URLs dynamically
  const backendHealthcheckUrl = `http://localhost:${process.env.PORT}/healthcheck`;
  const authBaseUrl = new URL(process.env.BETTER_AUTH_URL).origin;
  const authHealthcheckUrl = `${authBaseUrl}/healthcheck`;

  const waitOnOptions = {
    resources: [backendHealthcheckUrl, authHealthcheckUrl],
    delay: 1000, // initial delay in ms
    interval: 500, // poll interval in ms
    timeout: 60000, // timeout in ms (e.g., 60 seconds)
    tcpTimeout: 1000, // tcp timeout in ms
    httpTimeout: 2000, // http timeout in ms
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

  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
  } else {
    global.access_token = await get_access_token();
  }
});
