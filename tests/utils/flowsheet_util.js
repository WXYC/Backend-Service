require('dotenv').config({ path: `${__dirname}/../../.env` });

// Use environment variables with fallbacks for testing
const TEST_HOST = process.env.TEST_HOST || 'http://localhost';
const PORT = process.env.CI_PORT || '8081';
const url = `${TEST_HOST}:${PORT}`;

exports.join_show = async (dj_id, access_token) => {
  const res = await fetch(`${url}/flowsheet/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify({
      dj_id: dj_id,
    }),
  });

  return res;
};

exports.leave_show = async (dj_id, access_token) => {
  const res = await fetch(`${url}/flowsheet/end`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify({
      dj_id: dj_id,
    }),
  });

  return res;
};
