require('dotenv').config({ path: `${__dirname}/../.env` });
// Better Auth integration - using AUTH_BYPASS for testing

global.primary_dj_id = '1';
global.secondary_dj_id = '2';
global.access_token = '';

beforeAll(async () => {
  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
    console.log('Auth bypass enabled for testing');
  } else {
    console.warn('AUTH_BYPASS is not set to true. Tests will use bypass mode.');
    global.access_token = 'Auth Bypass Enabled';
  }
});
