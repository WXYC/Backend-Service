const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous } = require('../utils/anonymous_auth');

/**
 * Slack Webhook Integration Tests
 *
 * Verifies that song requests are posted to the Slack webhook when
 * USE_MOCK_SERVICES=false and SLACK_WEBHOOK_URL points to the mock server.
 *
 * Requires mock-api-server to be running.
 */

const MOCK_API_URL = process.env.MOCK_API_URL;

async function resetMockApi() {
  if (!MOCK_API_URL) return;
  await fetch(`${MOCK_API_URL}/_admin/reset`, { method: 'POST' });
}

async function getMockRequests(service) {
  if (!MOCK_API_URL) return [];
  const res = await fetch(`${MOCK_API_URL}/_admin/requests/${service}`);
  return res.json();
}

async function simulateError(service, endpoint, status) {
  if (!MOCK_API_URL) return;
  await fetch(`${MOCK_API_URL}/_admin/errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, endpoint, status }),
  });
}

describe('Slack Webhook (Mock API)', () => {
  let testToken;

  beforeAll(async () => {
    if (!MOCK_API_URL) {
      console.warn('Skipping: MOCK_API_URL not set');
      return;
    }
    const { token } = await signInAnonymous();
    testToken = token;
  });

  beforeEach(async () => {
    await resetMockApi();
  });

  test('song request posts message to mock Slack webhook', async () => {
    if (!MOCK_API_URL || !testToken) return;

    await request
      .post('/request')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ message: 'Play VI Scose Poise by Autechre' })
      .expect(200);

    // Allow Slack posting to complete (it may be async)
    await new Promise((r) => setTimeout(r, 300));

    const slackRequests = await getMockRequests('slack');
    expect(slackRequests.length).toBeGreaterThanOrEqual(1);

    // Verify the webhook received a POST with a JSON body
    const webhookCall = slackRequests[0];
    expect(webhookCall.method).toBe('POST');
    expect(webhookCall.body).toBeDefined();
    // Payload should have either text or blocks
    expect(webhookCall.body.text || webhookCall.body.blocks).toBeDefined();
  });

  test('Slack webhook failure does not break the request response', async () => {
    if (!MOCK_API_URL || !testToken) return;

    await simulateError('slack', '/services', 500);

    const res = await request
      .post('/request')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ message: 'Play Back Baby by Jessica Pratt' })
      .expect(200);

    // Request should still succeed even though Slack webhook failed
    expect(res.body.success).toBe(true);
  });
});
