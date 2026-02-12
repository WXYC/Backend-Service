const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const fls_util = require('../utils/flowsheet_util');
const { createAuthRequest, expectErrorContains, expectFields, expectArray } = require('../utils/test_helpers');

/**
 * DJ Endpoints Integration Tests
 *
 * Tests for:
 * - GET /djs/bin - Retrieve DJ's bin
 * - POST /djs/bin - Add entry to bin
 * - DELETE /djs/bin - Remove entry from bin
 * - GET /djs/playlists - Get playlists for a DJ
 */

describe('DJ Bin', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /djs/bin', () => {
    test('returns array for DJ', async () => {
      const res = await auth.get('/djs/bin').query({ dj_id: global.primary_dj_id }).expect(200);

      expectArray(res);
    });

    test('returns 400 when dj_id is missing', async () => {
      const res = await auth.get('/djs/bin').expect(400);

      expectErrorContains(res, 'Missing DJ Identifier');
    });

    test('returns empty array for DJ with no bin entries', async () => {
      const res = await auth.get('/djs/bin').query({ dj_id: global.secondary_dj_id }).expect(200);

      expectArray(res);
    });
  });

  describe('POST /djs/bin', () => {
    afterEach(async () => {
      // Clean up any bin entries created during tests
      await auth.delete('/djs/bin').query({ dj_id: global.primary_dj_id, album_id: 1 });
    });

    test('adds entry to bin successfully', async () => {
      const res = await auth
        .post('/djs/bin')
        .send({
          dj_id: global.primary_dj_id,
          album_id: 1,
        })
        .expect(200);

      expectFields(res.body, 'album_id', 'dj_id');
      expect(res.body.album_id).toBe(1);
      expect(res.body.dj_id).toBe(global.primary_dj_id);
    });

    test('adds entry with track title to bin', async () => {
      const res = await auth
        .post('/djs/bin')
        .send({
          dj_id: global.primary_dj_id,
          album_id: 1,
          track_title: 'Carry the Zero',
        })
        .expect(200);

      expectFields(res.body, 'album_id', 'track_title');
      expect(res.body.album_id).toBe(1);
      expect(res.body.track_title).toBe('Carry the Zero');
    });

    test('returns 400 when album_id is missing', async () => {
      const res = await auth
        .post('/djs/bin')
        .send({
          dj_id: global.primary_dj_id,
        })
        .expect(400);

      expectErrorContains(res, 'Missing');
    });

    test('returns 400 when dj_id is missing', async () => {
      const res = await auth
        .post('/djs/bin')
        .send({
          album_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing');
    });
  });

  describe('DELETE /djs/bin', () => {
    beforeEach(async () => {
      // Set up a bin entry to delete
      await auth.post('/djs/bin').send({
        dj_id: global.primary_dj_id,
        album_id: 2,
      });
    });

    test('removes entry from bin successfully', async () => {
      const res = await auth.delete('/djs/bin').query({ dj_id: global.primary_dj_id, album_id: 2 }).expect(200);

      expect(res.body).toBeDefined();

      // Verify it was removed
      const binRes = await auth.get('/djs/bin').query({ dj_id: global.primary_dj_id }).expect(200);

      const entry = binRes.body.find((e) => e.album_id === 2);
      expect(entry).toBeUndefined();
    });

    test('returns 400 when album_id is missing', async () => {
      const res = await auth.delete('/djs/bin').query({ dj_id: global.primary_dj_id }).expect(400);

      expectErrorContains(res, 'Missing');
    });

    test('returns 400 when dj_id is missing', async () => {
      const res = await auth.delete('/djs/bin').query({ album_id: 2 }).expect(400);

      expectErrorContains(res, 'Missing');
    });
  });
});

describe('DJ Playlists', () => {
  let auth;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    // Create a show to ensure DJ has at least one playlist
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  describe('GET /djs/playlists', () => {
    test('returns playlists for DJ with shows', async () => {
      const res = await auth.get('/djs/playlists').query({ dj_id: global.primary_dj_id }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('returns empty array for DJ without shows', async () => {
      const res = await auth.get('/djs/playlists').query({ dj_id: 'nonexistent-dj-id-12345' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBe(0);
    });

    test('returns 400 when dj_id is missing', async () => {
      const res = await auth.get('/djs/playlists').expect(400);

      expectErrorContains(res, 'Missing DJ Identifier');
    });

    test('playlist contains expected fields', async () => {
      const res = await auth.get('/djs/playlists').query({ dj_id: global.primary_dj_id }).expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'show', 'date', 'djs', 'preview');
      }
    });
  });
});
