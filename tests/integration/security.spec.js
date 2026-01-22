const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Security Integration Tests
 *
 * Tests for authentication, authorization, and input validation.
 */

describe('Authentication Tests', () => {
  describe('Missing Authentication', () => {
    const protectedEndpoints = [
      { method: 'get', path: '/library', query: { artist_name: 'test' } },
      { method: 'get', path: '/library/formats' },
      { method: 'get', path: '/library/genres' },
      { method: 'get', path: '/library/rotation' },
      { method: 'post', path: '/library', body: {} },
      { method: 'get', path: '/djs/bin', query: { dj_id: 1 } },
      { method: 'post', path: '/djs/bin', body: {} },
      { method: 'delete', path: '/djs/bin', body: {} },
      { method: 'get', path: '/djs/playlists', query: { dj_id: 1 } },
      { method: 'post', path: '/flowsheet/join', body: {} },
      { method: 'post', path: '/flowsheet/end', body: {} },
      { method: 'post', path: '/events/register', body: {} },
    ];

    protectedEndpoints.forEach(({ method, path, query, body }) => {
      test(`${method.toUpperCase()} ${path} requires authentication`, async () => {
        let req = request[method](path);

        if (query) {
          req = req.query(query);
        }
        if (body) {
          req = req.send(body);
        }

        const res = await req;

        // Should return 401 Unauthorized or 403 Forbidden
        expect([401, 403]).toContain(res.status);
      });
    });
  });

  describe('Invalid Token', () => {
    test('should reject malformed token', async () => {
      const res = await request
        .get('/library/formats')
        .set('Authorization', 'invalid-token');

      expect([401, 403]).toContain(res.status);
    });

    test('should reject Bearer prefix without token', async () => {
      const res = await request.get('/library/formats').set('Authorization', 'Bearer ');

      expect([401, 403]).toContain(res.status);
    });

    test('should reject random JWT-like string', async () => {
      const fakeJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

      const res = await request
        .get('/library/formats')
        .set('Authorization', `Bearer ${fakeJwt}`);

      expect([401, 403]).toContain(res.status);
    });
  });

  describe('Valid Authentication', () => {
    test('should accept valid token', async () => {
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

      // Should return 404 (no results) or safe error, not 500
      expect([404, 400]).toContain(res.status);
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
    test('should reject string where number expected', async () => {
      const res = await request
        .get('/library/info')
        .query({ album_id: 'not-a-number' })
        .set('Authorization', global.access_token);

      expect([400, 404]).toContain(res.status);
    });

    test('should reject negative IDs', async () => {
      const res = await request
        .get('/library/info')
        .query({ album_id: -1 })
        .set('Authorization', global.access_token);

      expect([400, 404]).toContain(res.status);
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
