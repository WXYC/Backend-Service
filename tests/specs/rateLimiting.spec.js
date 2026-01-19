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
const crypto = require('crypto');

// Skip these tests if rate limiting is not enabled
const rateLimitingEnabled = process.env.TEST_RATE_LIMITING === 'true';
const describeOrSkip = rateLimitingEnabled ? describe : describe.skip;

// Helper to generate unique device IDs for test isolation
const generateTestDeviceId = () => crypto.randomUUID();

// Helper to register a test device and get a token
const registerTestDevice = async (deviceId = null) => {
  const testDeviceId = deviceId || generateTestDeviceId();
  const response = await request
    .post('/request/register')
    .send({ deviceId: testDeviceId });

  return {
    deviceId: testDeviceId,
    token: response.body.token,
    expiresAt: response.body.expiresAt,
    response,
  };
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

  describe('Registration Rate Limiting', () => {
    it('should allow requests up to the limit', async () => {
      // Each request uses a different device ID but same IP
      // Rate limit is per-IP for registration
      const responses = [];

      for (let i = 0; i < REGISTRATION_MAX; i++) {
        const response = await request
          .post('/request/register')
          .send({ deviceId: generateTestDeviceId() });
        responses.push(response);
      }

      // All requests within limit should succeed
      responses.forEach((response, index) => {
        expect(response.status).toBe(200);
        expect(response.body.token).toBeDefined();
      });
    });

    it('should return 429 when registration limit is exceeded', async () => {
      // Wait for any previous window to reset
      await waitForWindowReset(WINDOW_MS);

      // Make requests up to the limit
      for (let i = 0; i < REGISTRATION_MAX; i++) {
        await request
          .post('/request/register')
          .send({ deviceId: generateTestDeviceId() });
      }

      // Next request should be rate limited
      const limitedResponse = await request
        .post('/request/register')
        .send({ deviceId: generateTestDeviceId() });

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.body.message).toMatch(/too many/i);
      expect(limitedResponse.body.retryAfter).toBeDefined();
    });

    it('should include rate limit headers', async () => {
      await waitForWindowReset(WINDOW_MS);

      const response = await request
        .post('/request/register')
        .send({ deviceId: generateTestDeviceId() });

      expect(response.status).toBe(200);
      // Standard rate limit headers
      expect(response.headers['ratelimit-limit']).toBeDefined();
      expect(response.headers['ratelimit-remaining']).toBeDefined();
      expect(response.headers['ratelimit-reset']).toBeDefined();
    });

    it('should reset after window expires', async () => {
      // Wait for window to reset
      await waitForWindowReset(WINDOW_MS);

      // Exhaust the limit
      for (let i = 0; i < REGISTRATION_MAX; i++) {
        await request
          .post('/request/register')
          .send({ deviceId: generateTestDeviceId() });
      }

      // Verify we're rate limited
      const limitedResponse = await request
        .post('/request/register')
        .send({ deviceId: generateTestDeviceId() });
      expect(limitedResponse.status).toBe(429);

      // Wait for window to reset
      await waitForWindowReset(WINDOW_MS);

      // Should be able to make requests again
      const resetResponse = await request
        .post('/request/register')
        .send({ deviceId: generateTestDeviceId() });
      expect(resetResponse.status).toBe(200);
    });
  });

  describe('Song Request Rate Limiting', () => {
    it('should allow requests up to the limit per device', async () => {
      // Register a device first
      const { token } = await registerTestDevice();

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

    it('should return 429 when request limit is exceeded for a device', async () => {
      // Wait for window reset and register a fresh device
      await waitForWindowReset(WINDOW_MS);
      const { token } = await registerTestDevice();

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

    it('should track rate limits separately per device', async () => {
      await waitForWindowReset(WINDOW_MS);

      // Register two different devices
      const device1 = await registerTestDevice();
      const device2 = await registerTestDevice();

      // Exhaust limit for device 1
      for (let i = 0; i < REQUEST_MAX; i++) {
        await request
          .post('/request')
          .set('Authorization', `Bearer ${device1.token}`)
          .send({ message: `Device 1 request ${i}` });
      }

      // Device 1 should be rate limited
      const device1Limited = await request
        .post('/request')
        .set('Authorization', `Bearer ${device1.token}`)
        .send({ message: 'Device 1 limited' });
      expect(device1Limited.status).toBe(429);

      // Device 2 should still be able to make requests
      const device2Response = await request
        .post('/request')
        .set('Authorization', `Bearer ${device2.token}`)
        .send({ message: 'Device 2 should work' });
      expect(device2Response.status).toBe(200);
    });

    it('should include rate limit headers on requests', async () => {
      await waitForWindowReset(WINDOW_MS);
      const { token } = await registerTestDevice();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.headers['ratelimit-limit']).toBeDefined();
      expect(response.headers['ratelimit-remaining']).toBeDefined();
      expect(response.headers['ratelimit-reset']).toBeDefined();
    });
  });
});

// Export helper for use in other test files
module.exports = { generateTestDeviceId, registerTestDevice };
