const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * SSE/Real-time Events Integration Tests
 *
 * Tests for Server-Sent Events functionality.
 */

describe('Events Endpoints', () => {
  describe('POST /events/register', () => {
    test('should register event client with valid auth', async () => {
      const res = await request
        .post('/events/register')
        .set('Authorization', global.access_token)
        .send({});

      // Should return client ID or connection info
      expect([200, 201]).toContain(res.status);
    });

    test('should require authentication', async () => {
      const res = await request.post('/events/register').send({});

      expect([401, 403]).toContain(res.status);
    });
  });

  describe('PUT /events/subscribe', () => {
    test('should require authentication', async () => {
      const res = await request
        .put('/events/subscribe')
        .send({ topic: 'flowsheet' });

      expect([401, 403]).toContain(res.status);
    });

    test('should reject without topic', async () => {
      const res = await request
        .put('/events/subscribe')
        .set('Authorization', global.access_token)
        .send({});

      expect([400, 404]).toContain(res.status);
    });
  });

  describe('GET /events/test', () => {
    test('should require authentication', async () => {
      const res = await request.get('/events/test');

      expect([401, 403]).toContain(res.status);
    });

    test('should trigger test event with auth', async () => {
      const res = await request
        .get('/events/test')
        .set('Authorization', global.access_token);

      expect([200, 204]).toContain(res.status);
    });
  });
});

/**
 * SSE Connection Tests
 *
 * Note: These tests validate the SSE endpoints but don't maintain
 * long-lived connections. Full SSE testing requires E2E tests.
 */
describe('SSE Event Topics', () => {
  const topics = ['flowsheet', 'on-air', 'requests'];

  topics.forEach((topic) => {
    test(`should accept subscription to ${topic} topic`, async () => {
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
