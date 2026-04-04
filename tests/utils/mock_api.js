/**
 * Mock API server test utilities.
 *
 * Provides helpers for interacting with the mock-api-server's control API.
 * Tests should call `isMockApiAvailable()` in beforeAll and skip if false.
 */

const MOCK_API_URL = process.env.MOCK_API_URL;

/**
 * Check if the mock API server is configured and reachable.
 * Call this once in beforeAll and skip tests if false.
 */
async function isMockApiAvailable() {
  if (!MOCK_API_URL) return false;
  try {
    const res = await fetch(`${MOCK_API_URL}/_admin/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Reset mock server state (request log + error rules). */
async function resetMockApi() {
  await fetch(`${MOCK_API_URL}/_admin/reset`, { method: 'POST' });
}

/** Get recorded requests, optionally filtered by service. */
async function getMockRequests(service) {
  const path = service ? `/_admin/requests/${service}` : '/_admin/requests';
  const res = await fetch(`${MOCK_API_URL}${path}`);
  return res.json();
}

/** Configure an error simulation rule on the mock server. */
async function simulateError(service, endpoint, status, count) {
  await fetch(`${MOCK_API_URL}/_admin/errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, endpoint, status, count }),
  });
}

module.exports = {
  MOCK_API_URL,
  isMockApiAvailable,
  resetMockApi,
  getMockRequests,
  simulateError,
};
