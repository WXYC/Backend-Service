/**
 * Rate Limiting Integration Tests
 *
 * These tests verify that rate limiting is properly enforced.
 * They require the server to be started with rate limiting enabled and configured
 * with short windows for testing:
 *
 * Environment variables for testing:
 *   TEST_RATE_LIMITING=true
 *   RATE_LIMIT_REGISTRATION_WINDOW_MS=2000   (2 seconds)
 *   RATE_LIMIT_REGISTRATION_MAX=3
 *   RATE_LIMIT_REQUEST_WINDOW_MS=2000        (2 seconds)
 *   RATE_LIMIT_REQUEST_MAX=3
 *
 * Run with:
 *   TEST_RATE_LIMITING=true \
 *   RATE_LIMIT_REGISTRATION_MAX=3 \
 *   RATE_LIMIT_REQUEST_MAX=3 \
 *   RATE_LIMIT_REGISTRATION_WINDOW_MS=2000 \
 *   RATE_LIMIT_REQUEST_WINDOW_MS=2000 \
 *   npm test -- --testPathPattern=rateLimiting
 */

require('dotenv').config({ path: '../../.env' });
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous } = require('../utils/anonymous_auth');

// Skip these tests if rate limiting is not enabled
const rateLimitingEnabled = process.env.TEST_RATE_LIMITING === 'true';
const describeOrSkip = rateLimitingEnabled ? describe : describe.skip;

// Helper to sign in as an anonymous user and get a token
const getTestToken = async () => {
  const { token, userId, user } = await signInAnonymous();
  return { token, userId, user };
};

// Helper to wait for rate limit window to reset
const waitForWindowReset = (windowMs = 2000) => {
  return new Promise((resolve) => setTimeout(resolve, windowMs + 100));
};

describeOrSkip('Rate Limiting', () => {
  // Get configured limits from environment (with defaults matching test recommendations)
  const REGISTRATION_MAX = parseInt(process.env.RATE_LIMIT_REGISTRATION_MAX || '3', 10);
  const REQUEST_MAX = parseInt(process.env.RATE_LIMIT_REQUEST_MAX || '3', 10);
  const WINDOW_MS = parseInt(process.env.RATE_LIMIT_REQUEST_WINDOW_MS || '2000', 10);

  describe('Registration Rate Limiting (Legacy Endpoint)', () => {
    it('should rate limit the legacy registration endpoint by IP', async () => {
      // Wait for any previous window to reset
      await waitForWindowReset(WINDOW_MS);

      // Make requests up to the limit
      const responses = [];
      for (let i = 0; i < REGISTRATION_MAX; i++) {
        const response = await request.post('/request/register').send({});
        responses.push(response);
      }

      // All requests within limit should return 301 (deprecated redirect)
      responses.forEach((response) => {
        expect(response.status).toBe(301);
      });

      // Next request should be rate limited
      const limitedResponse = await request.post('/request/register').send({});

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.body.message).toMatch(/too many/i);
    });
  });

  describe('Song Request Rate Limiting', () => {
    it('should allow requests up to the limit per user', async () => {
      // Get a fresh anonymous user token
      const { token } = await getTestToken();

      const responses = [];
      for (let i = 0; i < REQUEST_MAX; i++) {
        const response = await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: `Test request ${i}` });
        responses.push(response);
      }

      // All requests within limit should succeed
      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });
    });

    it('should return 429 when request limit is exceeded for a user', async () => {
      // Wait for window reset and get a fresh user
      await waitForWindowReset(WINDOW_MS);
      const { token } = await getTestToken();

      // Make requests up to the limit
      for (let i = 0; i < REQUEST_MAX; i++) {
        await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: `Test request ${i}` });
      }

      // Next request should be rate limited
      const limitedResponse = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'This should be rate limited' });

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.body.message).toMatch(/too many/i);
      expect(limitedResponse.body.retryAfter).toBeDefined();
    });

    it('should track rate limits separately per user', async () => {
      await waitForWindowReset(WINDOW_MS);

      // Get two different anonymous users
      const user1 = await getTestToken();
      const user2 = await getTestToken();

      // Exhaust limit for user 1
      for (let i = 0; i < REQUEST_MAX; i++) {
        await request
          .post('/request')
          .set('Authorization', `Bearer ${user1.token}`)
          .send({ message: `User 1 request ${i}` });
      }

      // User 1 should be rate limited
      const user1Limited = await request
        .post('/request')
        .set('Authorization', `Bearer ${user1.token}`)
        .send({ message: 'User 1 limited' });
      expect(user1Limited.status).toBe(429);

      // User 2 should still be able to make requests
      const user2Response = await request
        .post('/request')
        .set('Authorization', `Bearer ${user2.token}`)
        .send({ message: 'User 2 should work' });
      expect(user2Response.status).toBe(200);
    });

    it('should include rate limit headers on requests', async () => {
      await waitForWindowReset(WINDOW_MS);
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.headers['ratelimit-limit']).toBeDefined();
      expect(response.headers['ratelimit-remaining']).toBeDefined();
      expect(response.headers['ratelimit-reset']).toBeDefined();
    });

    it('should reset after window expires', async () => {
      // Wait for window to reset
      await waitForWindowReset(WINDOW_MS);

      const { token } = await getTestToken();

      // Exhaust the limit
      for (let i = 0; i < REQUEST_MAX; i++) {
        await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: `Request ${i}` });
      }

      // Verify we're rate limited
      const limitedResponse = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Should be limited' });
      expect(limitedResponse.status).toBe(429);

      // Wait for window to reset
      await waitForWindowReset(WINDOW_MS);

      // Should be able to make requests again
      const resetResponse = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Should work after reset' });
      expect(resetResponse.status).toBe(200);
    });
  });
});

// Export helper for use in other test files
module.exports = { getTestToken };
