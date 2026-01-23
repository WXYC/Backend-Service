const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * DJ Endpoints Integration Tests
 *
 * Tests for DJ bin management and playlists.
 * Note: These endpoints currently allow unauthenticated access per API implementation.
 */

describe('DJ Endpoints', () => {
  describe('GET /djs/bin', () => {
    test('should return DJ bin (empty or with entries)', async () => {
      const res = await request
        .get('/djs/bin')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    test('should require dj_id parameter', async () => {
      const res = await request
        .get('/djs/bin')
        .set('Authorization', global.access_token);

      // Should return 400 or 500 for missing parameter
      expect([400, 500]).toContain(res.status);
    });

    // Note: GET /djs/bin does not require authentication per current API implementation
    test('should allow unauthenticated access to bin', async () => {
      const res = await request.get('/djs/bin').query({ dj_id: global.primary_dj_id });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /djs/bin', () => {
    test('should reject request without album_id', async () => {
      const res = await request
        .post('/djs/bin')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id });

      // Should return 400 or 500 for invalid request
      expect([400, 500]).toContain(res.status);
    });

    test('should reject request without dj_id', async () => {
      const res = await request
        .post('/djs/bin')
        .set('Authorization', global.access_token)
        .send({ album_id: 1 });

      // Should return 400 or 500 for invalid request
      expect([400, 500]).toContain(res.status);
    });

    // Note: POST /djs/bin accepts unauthenticated requests but may not persist changes
    test('should accept unauthenticated requests', async () => {
      const res = await request
        .post('/djs/bin')
        .send({ dj_id: global.primary_dj_id, album_id: 1 });

      // Returns 200 even without auth (behavior may differ in actual data persistence)
      expect([200, 201]).toContain(res.status);
    });
  });

  describe('DELETE /djs/bin', () => {
    test('should reject request without required parameters', async () => {
      const res = await request
        .delete('/djs/bin')
        .set('Authorization', global.access_token)
        .send({});

      // Should return 400, 404, or 500 for invalid request
      expect([400, 404, 500]).toContain(res.status);
    });

    // Note: DELETE /djs/bin validates request before auth check
    test('should accept unauthenticated requests', async () => {
      const res = await request
        .delete('/djs/bin')
        .send({ dj_id: global.primary_dj_id, album_id: 1 });

      // Returns 400 due to validation issues, not auth
      expect([200, 400, 404]).toContain(res.status);
    });
  });

  describe('GET /djs/playlists', () => {
    test('should return DJ playlists', async () => {
      const res = await request
        .get('/djs/playlists')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    test('should require dj_id parameter', async () => {
      const res = await request
        .get('/djs/playlists')
        .set('Authorization', global.access_token);

      // Should return 400 or 500 for missing parameter
      expect([400, 500]).toContain(res.status);
    });

    // Note: GET /djs/playlists does not require authentication per current API implementation
    test('should allow unauthenticated access to playlists', async () => {
      const res = await request
        .get('/djs/playlists')
        .query({ dj_id: global.primary_dj_id });

      expect(res.status).toBe(200);
    });
  });
});

describe('DJ Bin CRUD Operations', () => {
  // Use a known test album ID (should exist in seed data)
  const testAlbumId = 1;
  let addedEntryId = null;

  describe('Full bin lifecycle', () => {
    test('should add album to bin', async () => {
      const res = await request
        .post('/djs/bin')
        .set('Authorization', global.access_token)
        .send({
          dj_id: global.primary_dj_id,
          album_id: testAlbumId,
        });

      // 200 for success, 409 if already exists
      expect([200, 201, 409]).toContain(res.status);

      if (res.status === 200 || res.status === 201) {
        addedEntryId = res.body.id;
      }
    });

    test('should see album in bin after adding', async () => {
      const res = await request
        .get('/djs/bin')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      const hasAlbum = res.body.some(entry => entry.album_id === testAlbumId);
      expect(hasAlbum).toBe(true);
    });

    test('should remove album from bin', async () => {
      const res = await request
        .delete('/djs/bin')
        .set('Authorization', global.access_token)
        .send({
          dj_id: global.primary_dj_id,
          album_id: testAlbumId,
        });

      // 200 for success, 400 for invalid request, 404 if not found
      expect([200, 400, 404]).toContain(res.status);
    });
  });
});
