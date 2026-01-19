const waitOn = require('wait-on');

module.exports = async () => {
  // Sensible defaults for ports/hosts used in CI
  const backendHost = process.env.BACKEND_HOST || 'localhost';
  const backendPort = process.env.PORT || process.env.BACKEND_PORT || process.env.CI_PORT || 8081;
  const backendHealthcheckUrl = `http://${backendHost}:${backendPort}/healthcheck`;

  // BETTER_AUTH_URL may be a full URL; if not present, fall back to AUTH_HOST/AUTH_PORT
  let authBaseUrl;
  if (process.env.BETTER_AUTH_URL) {
    try {
      authBaseUrl = new URL(process.env.BETTER_AUTH_URL).origin;
    } catch (err) {
      authBaseUrl = `http://${process.env.AUTH_HOST || 'localhost'}:${process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083}`;
    }
  } else {
    authBaseUrl = `http://${process.env.AUTH_HOST || 'localhost'}:${process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083}`;
  }
  const authHealthcheckUrl = `${authBaseUrl}/healthcheck`;

  console.log('🚀 Global Setup: Waiting for services...');
  console.log('   Backend:', backendHealthcheckUrl);
  console.log('   Auth:', authHealthcheckUrl);

  const waitOnOptions = {
    resources: [backendHealthcheckUrl, authHealthcheckUrl],
    delay: 500,
    interval: 250,
    timeout: 60000,
    tcpTimeout: 1000,
    httpTimeout: 2000,
    log: false,
  };

  try {
    await waitOn(waitOnOptions);
    console.log('✅ Services are ready!');
  } catch (err) {
    console.error('❌ Error waiting for services:', err);
    throw err;
  }
};
