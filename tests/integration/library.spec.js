const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Library (Catalog) Integration Tests
 *
 * Tests for album catalog, rotation, formats, genres, and artist management.
 */

describe('Library Endpoints', () => {
  describe('GET /library - Album Search', () => {
    test('should search albums by artist name', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'test' })
        .set('Authorization', global.access_token)
        .expect(200);

      // May return 200 with results or 404 if no matches
      if (res.status === 200) {
        expect(Array.isArray(res.body)).toBe(true);
      }
    });

    test('should search albums by album name', async () => {
      const res = await request
        .get('/library')
        .query({ album_name: 'test' })
        .set('Authorization', global.access_token);

      // Returns 200 with results or 404 if no matches
      expect([200, 404]).toContain(res.status);
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

    test('should return 404 for no results', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'xyznonexistent123456789' })
        .set('Authorization', global.access_token)
        .expect(404);

      expect(res.body.message).toBeDefined();
    });

    test('should require authentication', async () => {
      const res = await request.get('/library').query({ artist_name: 'test' });

      expect([401, 403]).toContain(res.status);
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

    test('should require authentication', async () => {
      const res = await request.get('/library/formats');

      expect([401, 403]).toContain(res.status);
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
        .send({})
        .expect(400);

      expect(res.body.message).toBeDefined();
    });
  });

  describe('POST /library/genres', () => {
    test('should reject request without required fields', async () => {
      const res = await request
        .post('/library/genres')
        .set('Authorization', global.access_token)
        .send({})
        .expect(400);

      expect(res.body.message).toBeDefined();
    });
  });

  describe('GET /library/info', () => {
    test('should reject request without album_id', async () => {
      const res = await request
        .get('/library/info')
        .set('Authorization', global.access_token)
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    test('should return 404 for non-existent album', async () => {
      const res = await request
        .get('/library/info')
        .query({ album_id: 999999 })
        .set('Authorization', global.access_token)
        .expect(404);

      expect(res.body.message).toBeDefined();
    });
  });
});
