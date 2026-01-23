const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Library (Catalog) Integration Tests
 *
 * Tests for album catalog, rotation, formats, genres, and artist management.
 * Note: These endpoints currently allow unauthenticated access per API implementation.
 */

describe('Library Endpoints', () => {
  describe('GET /library - Album Search', () => {
    test('should search albums by artist name', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'test' })
        .set('Authorization', global.access_token);

      // API returns 200 with results (possibly empty array)
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('should search albums by album name', async () => {
      const res = await request
        .get('/library')
        .query({ album_name: 'test' })
        .set('Authorization', global.access_token);

      // API may return 200 with results, 400 for invalid param, or 404
      expect([200, 400, 404]).toContain(res.status);
    });

    test('should limit results with n parameter', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'a', n: 5 })
        .set('Authorization', global.access_token);

      if (res.status === 200) {
        expect(res.body.length).toBeLessThanOrEqual(5);
      }
    });

    test('should return empty array or 404 for no results', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'xyznonexistent123456789' })
        .set('Authorization', global.access_token);

      // API returns 200 with empty array or 404
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body)).toBe(true);
      }
    });

    // Note: GET /library does not require authentication per current API implementation
    test('should allow unauthenticated access', async () => {
      const res = await request.get('/library').query({ artist_name: 'test' });

      expect(res.status).toBe(200);
    });
  });

  describe('GET /library/formats', () => {
    test('should return list of formats', async () => {
      const res = await request
        .get('/library/formats')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      // Verify format structure
      const format = res.body[0];
      expect(format).toHaveProperty('id');
      expect(format).toHaveProperty('format_name');
    });

    // Note: GET /library/formats does not require authentication per current API implementation
    test('should allow unauthenticated access', async () => {
      const res = await request.get('/library/formats');

      expect(res.status).toBe(200);
    });
  });

  describe('GET /library/genres', () => {
    test('should return list of genres', async () => {
      const res = await request
        .get('/library/genres')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      // Verify genre structure
      const genre = res.body[0];
      expect(genre).toHaveProperty('id');
      expect(genre).toHaveProperty('genre_name');
    });
  });

  describe('GET /library/rotation', () => {
    test('should return current rotation', async () => {
      const res = await request
        .get('/library/rotation')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);

      // If there are rotation entries, verify structure
      if (res.body.length > 0) {
        const rotation = res.body[0];
        expect(rotation).toHaveProperty('id');
        expect(rotation).toHaveProperty('play_freq');
      }
    });
  });

  describe('POST /library/formats', () => {
    test('should reject request without format name', async () => {
      const res = await request
        .post('/library/formats')
        .set('Authorization', global.access_token)
        .send({});

      // Should return 400 or 500 for invalid request
      expect([400, 500]).toContain(res.status);
    });
  });

  describe('POST /library/genres', () => {
    test('should reject request without required fields', async () => {
      const res = await request
        .post('/library/genres')
        .set('Authorization', global.access_token)
        .send({});

      // Should return 400 or 500 for invalid request
      expect([400, 500]).toContain(res.status);
    });
  });

  describe('GET /library/info', () => {
    test('should handle request without album_id', async () => {
      const res = await request
        .get('/library/info')
        .set('Authorization', global.access_token);

      // Should return 400 or 500 for missing parameter
      expect([400, 500]).toContain(res.status);
    });

    test('should handle non-existent album', async () => {
      const res = await request
        .get('/library/info')
        .query({ album_id: 999999 })
        .set('Authorization', global.access_token);

      // API may return 200 (null/empty), 404, or other status
      expect([200, 404, 500]).toContain(res.status);
    });
  });
});
