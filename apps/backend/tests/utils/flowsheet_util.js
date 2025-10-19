// This function is assuming the /flowsheet/join enpoint is working properly
require('dotenv').config({ path: `${__dirname}/../../.env` });

// WSL compatibility: use Windows host IP instead of localhost
const getWindowsHostIP = () => {
  // In WSL, Windows host is usually at the first IP in the route table
  const { execSync } = require('child_process');
  try {
    const result = execSync("ip route show | grep default | awk '{print $3}'", { encoding: 'utf8' });
    return result.trim();
  } catch (error) {
    // Fallback to localhost if we can't determine Windows host IP
    return '127.0.0.1';
  }
};

const windowsHost = getWindowsHostIP();
const url = `http://${windowsHost}:${process.env.CI_PORT || 8081}`;

console.log(`[UTIL] Using test URL: ${url}`);
console.log(`[UTIL] Windows host IP detected: ${windowsHost}`);

exports.join_show = async (dj_id, access_token) => {
  console.log(`[UTIL] join_show starting for dj_id: ${dj_id}`);
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

  console.log(`[UTIL] join_show response status: ${res.status}`);
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
