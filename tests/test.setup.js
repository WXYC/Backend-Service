require('dotenv').config({ path: `${__dirname}/../.env` });
// Better Auth integration - using AUTH_BYPASS for testing

global.primary_dj_id = 1; // This corresponds to the DJ with user_id 'test-user-id'
global.secondary_dj_id = 2; // This corresponds to the DJ with user_id 'test-user-id-2'
global.access_token = '';

beforeAll(async () => {
  if (process.env.AUTH_BYPASS === 'true') {
    global.access_token = 'Auth Bypass Enabled';
  } else {
    // For non-bypass mode, you would need to implement proper JWT token retrieval
    // from the better-auth service. For now, we'll use bypass mode for testing.
    console.warn('AUTH_BYPASS is not set to true. Tests will use bypass mode.');
    global.access_token = 'Auth Bypass Enabled';
  }
});
