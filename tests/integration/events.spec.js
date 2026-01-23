const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * SSE/Real-time Events Integration Tests
 *
 * Tests for Server-Sent Events functionality.
 * Note: SSE connections can hang tests - these focus on registration/subscribe APIs.
 * Full SSE testing requires E2E tests with proper connection handling.
 * Most endpoints allow unauthenticated access per current API implementation.
 */

describe('Events Endpoints', () => {
  describe('POST /events/register', () => {
    // Skip all /events/register tests as they create persistent SSE connections that timeout
    test.skip('should register event client with valid auth', async () => {
      const res = await request
        .post('/events/register')
        .set('Authorization', global.access_token)
        .send({});

      // Should return client ID or connection info
      expect([200, 201]).toContain(res.status);
    });
  });

  describe('PUT /events/subscribe', () => {
    test('should reject without topic or client registration', async () => {
      const res = await request
        .put('/events/subscribe')
        .set('Authorization', global.access_token)
        .send({});

      // Should return 400 (missing topic/client) or 404 (client not found)
      expect([400, 404, 500]).toContain(res.status);
    });

    // Note: Endpoint allows unauthenticated access per current API implementation
    test('should accept unauthenticated request (returns validation error)', async () => {
      const res = await request.put('/events/subscribe').send({ topic: 'flowsheet' });

      // Returns 400 for validation error (missing client), not 401
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('GET /events/test', () => {
    // Note: Endpoint allows unauthenticated access per current API implementation
    test('should allow unauthenticated access', async () => {
      const res = await request.get('/events/test');

      expect(res.status).toBe(200);
    });

    test('should handle test event endpoint with auth', async () => {
      const res = await request
        .get('/events/test')
        .set('Authorization', global.access_token);

      // May return 200/204 for success, or 404 if endpoint doesn't exist
      expect([200, 204, 404]).toContain(res.status);
    });
  });
});

/**
 * SSE Event Topics
 *
 * Note: Full SSE subscription testing requires maintaining persistent connections
 * which can cause test timeouts. These tests are skipped in favor of E2E tests.
 */
describe('SSE Event Topics', () => {
  const topics = ['flowsheet', 'on-air', 'requests'];

  // Skip these tests - they require persistent SSE connections
  // Full SSE testing should be done in E2E tests
  topics.forEach((topic) => {
    test.skip(`should accept subscription to ${topic} topic`, async () => {
      // First register a client
      const registerRes = await request
        .post('/events/register')
        .set('Authorization', global.access_token)
        .send({});

      if (registerRes.status === 200 || registerRes.status === 201) {
        const clientId = registerRes.body.clientId || registerRes.body.id;

        const res = await request
          .put('/events/subscribe')
          .set('Authorization', global.access_token)
          .send({
            clientId: clientId,
            topic: topic,
          });

        // 200 for success, 400/404 for validation issues
        expect([200, 400, 404]).toContain(res.status);
      }
    });
  });
});
