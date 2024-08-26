const get_access_token = require('./utils/cognito_auth');

global.primary_dj_id = 1;
global.secondary_dj_id = 2;
global.access_token = '';

beforeAll(async () => {
  global.access_token = await get_access_token();
});
