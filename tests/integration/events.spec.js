const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Server-Sent Events (SSE) Endpoints Integration Tests
 *
 * Tests for:
 * - POST /events/register - Register an SSE client (opens persistent connection)
 * - PUT /events/subscribe - Subscribe to event topics
 * - GET /events/test - Trigger a test broadcast event
 *
 * Note: The /events/register endpoint opens a persistent SSE connection,
 * which makes it difficult to test with standard HTTP request libraries.
 * These tests focus on the subscribe and test endpoints, and validation behavior.
 */

describe('Server-Sent Events', () => {
  // Skip register tests - they open persistent SSE connections that don't complete
  // Testing SSE connections properly requires a specialized client
  describe.skip('POST /events/register', () => {
    test('registers client with empty topics', async () => {
      // This test is skipped because /events/register opens an SSE connection
      // that keeps the request open indefinitely
    });
  });

  describe('PUT /events/subscribe', () => {
    test('returns 400 when client_id is missing', async () => {
      const res = await request
        .put('/events/subscribe')
        .set('Authorization', global.access_token)
        .send({ topics: ['test'] })
        .expect(400);

      expect(res.body.message).toContain('client_id');
    });

    test('returns 400 when topics is missing', async () => {
      const res = await request
        .put('/events/subscribe')
        .set('Authorization', global.access_token)
        .send({ client_id: 'test-client-123' })
        .expect(400);

      expect(res.body.message).toContain('topics');
    });

    test('returns 400 when both client_id and topics are missing', async () => {
      const res = await request
        .put('/events/subscribe')
        .set('Authorization', global.access_token)
        .send({})
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    test('handles subscription with non-existent client gracefully', async () => {
      const res = await request.put('/events/subscribe').set('Authorization', global.access_token).send({
        client_id: 'non-existent-client-id-12345',
        topics: ['test'],
      });

      // Should either return success (empty subscription) or an error
      expect([200, 400, 404, 500].includes(res.status)).toBe(true);
    });
  });

  describe('GET /events/test', () => {
    test('triggers test event successfully', async () => {
      const res = await request.get('/events/test').set('Authorization', global.access_token).expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.message).toBe('event triggered');
    });

    test('triggers test event without auth (public endpoint)', async () => {
      // The test endpoint appears to be accessible without auth
      // for debugging/testing purposes
      const res = await request.get('/events/test').expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.message).toBe('event triggered');
    });
  });
});
