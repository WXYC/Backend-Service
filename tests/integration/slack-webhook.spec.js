const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous } = require('../utils/anonymous_auth');
const { isMockApiAvailable, resetMockApi, getMockRequests, simulateError } = require('../utils/mock_api');

/**
 * Slack Webhook Integration Tests
 *
 * Verifies that song requests are posted to the Slack webhook when
 * USE_MOCK_SERVICES=false and SLACK_WEBHOOK_URL points to the mock server.
 *
 * Requires mock-api-server to be running.
 */

let mockApiAvailable = false;

beforeAll(async () => {
  mockApiAvailable = await isMockApiAvailable();
  if (!mockApiAvailable) {
    console.warn('Skipping slack-webhook tests: mock API server not available');
  }
});

describe('Slack Webhook (Mock API)', () => {
  let testToken;

  beforeAll(async () => {
    if (!mockApiAvailable) return;
    const { token } = await signInAnonymous();
    testToken = token;
  });

  beforeEach(async () => {
    if (!mockApiAvailable) return;
    await resetMockApi();
  });

  test('song request posts message to mock Slack webhook', async () => {
    if (!mockApiAvailable || !testToken) return;

    await request
      .post('/request')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ message: 'Play VI Scose Poise by Autechre' })
      .expect(200);

    // Allow Slack posting to complete (it may be async)
    await new Promise((r) => setTimeout(r, 300));

    const slackRequests = await getMockRequests('slack');
    expect(slackRequests.length).toBeGreaterThanOrEqual(1);

    const webhookCall = slackRequests[0];
    expect(webhookCall.method).toBe('POST');
    expect(webhookCall.body).toBeDefined();
    expect(webhookCall.body.text || webhookCall.body.blocks).toBeDefined();
  });

  test('Slack webhook failure does not break the request response', async () => {
    if (!mockApiAvailable || !testToken) return;

    await simulateError('slack', '/services', 500);

    const res = await request
      .post('/request')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ message: 'Play Back Baby by Jessica Pratt' })
      .expect(200);

    expect(res.body.success).toBe(true);
  });
});
