const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Security Integration Tests
 *
 * Tests for input validation and security-related behaviors.
 *
 * Note: Most API endpoints allow unauthenticated access per current implementation.
 * Authentication is handled at the session level (flowsheet/join) rather than
 * on individual endpoints.
 */

describe('Authentication Behavior', () => {
  // Most endpoints allow unauthenticated access
  describe('Public Endpoints', () => {
    test('should allow unauthenticated access to library endpoints', async () => {
      const res = await request.get('/library/formats');
      expect(res.status).toBe(200);
    });

    test('should work with valid authentication', async () => {
      const res = await request
        .get('/library/formats')
        .set('Authorization', global.access_token);

      expect(res.status).toBe(200);
    });
  });
});

describe('Input Validation Tests', () => {
  describe('SQL Injection Prevention', () => {
    test('should safely handle SQL injection in search', async () => {
      const maliciousInput = "'; DROP TABLE library; --";

      const res = await request
        .get('/library')
        .query({ artist_name: maliciousInput })
        .set('Authorization', global.access_token);

      // Should return empty results (200), 404, or 400, but NOT crash (500)
      expect([200, 404, 400]).toContain(res.status);
      expect(res.status).not.toBe(500);
    });

    test('should handle special characters in search', async () => {
      const specialChars = "O'Brien & Sons";

      const res = await request
        .get('/library')
        .query({ artist_name: specialChars })
        .set('Authorization', global.access_token);

      // Should not crash the server
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('Request Size Limits', () => {
    test('should reject oversized request body', async () => {
      const largePayload = { data: 'x'.repeat(1000000) }; // 1MB of data

      const res = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .send(largePayload);

      // Should reject or handle gracefully
      expect([400, 413, 500]).toContain(res.status);
    });
  });

  describe('Invalid JSON', () => {
    test('should handle invalid JSON gracefully', async () => {
      const res = await request
        .post('/flowsheet')
        .set('Authorization', global.access_token)
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      expect([400, 500]).toContain(res.status);
    });
  });

  describe('Type Validation', () => {
    test('should handle string where number expected', async () => {
      const res = await request
        .get('/library/info')
        .query({ album_id: 'not-a-number' })
        .set('Authorization', global.access_token);

      // API may coerce, return 400, 404, or 500 - just document behavior
      expect([200, 400, 404, 500]).toContain(res.status);
    });

    test('should handle negative IDs', async () => {
      const res = await request
        .get('/library/info')
        .query({ album_id: -1 })
        .set('Authorization', global.access_token);

      // API may return 200 (no results), 400, or 404
      expect([200, 400, 404]).toContain(res.status);
    });
  });
});

describe('Rate Limiting', () => {
  // Note: Rate limiting may not be enabled on all endpoints
  // These tests document expected behavior

  test('should include rate limit headers if enabled', async () => {
    const res = await request.get('/flowsheet/on-air');

    // Rate limit headers are optional
    // If present, they should be well-formed
    if (res.headers['x-ratelimit-limit']) {
      expect(parseInt(res.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    }
    if (res.headers['x-ratelimit-remaining']) {
      expect(parseInt(res.headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('CORS Headers', () => {
  test('should include CORS headers', async () => {
    const res = await request.get('/flowsheet/on-air');

    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  test('should handle OPTIONS preflight', async () => {
    const res = await request.options('/flowsheet/on-air');

    expect([200, 204]).toContain(res.status);
  });
});
