const get_access_token = require('./utils/cognito_auth');

global.access_token = '';

beforeAll(async () => {
  global.access_token = await get_access_token();
});
