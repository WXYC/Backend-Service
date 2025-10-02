require('dotenv').config({ path: `${__dirname}/../.env` });
// Better Auth integration - using AUTH_BYPASS for testing

// Note: DJ IDs have been migrated to user IDs in the database schema
// These correspond to user entries in the users table, not the old djs table
global.primary_dj_id = '1'; // This corresponds to a user with ID '1' (test-user-id)
global.secondary_dj_id = '2'; // This corresponds to a user with ID '2' (test-user-id-2)
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
