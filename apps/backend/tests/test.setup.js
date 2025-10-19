require('dotenv').config({ path: `${__dirname}/../../../.env` });
const get_access_token = require('./utils/cognito_auth');

global.primary_dj_id = 1;
global.secondary_dj_id = 2;
global.access_token = '';

// Helper function to conditionally set Authorization header
global.setAuthHeader = (request) => {
  if (global.access_token) {
    return request.set('Authorization', global.access_token);
  }
  return request;
};

beforeAll(async () => {
  console.log('[TEST] beforeAll starting');
  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
  } else {
    global.access_token = await get_access_token();
  }
  console.log('[TEST] beforeAll complete');
});
