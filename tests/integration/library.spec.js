const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains, expectFields, expectArray } = require('../utils/test_helpers');

/**
 * Library Endpoints Integration Tests
 *
 * Tests for:
 * - GET /library - Fuzzy search for albums
 * - POST /library - Add album to library
 * - GET /library/rotation - Get active rotations
 * - POST /library/rotation - Add album to rotation
 * - PATCH /library/rotation - Kill rotation entry
 * - POST /library/artists - Add artist
 * - GET /library/formats - Get all formats
 * - POST /library/formats - Add format
 * - GET /library/genres - Get all genres
 * - POST /library/genres - Add genre
 * - GET /library/info - Get album info
 */

describe('Library Catalog', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library (Fuzzy Search)', () => {
    test('searches by artist name', async () => {
      const res = await auth.get('/library').query({ artist_name: 'Built to Spill' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('searches by album title', async () => {
      const res = await auth.get('/library').query({ album_title: 'Keep it Like a Secret' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('searches by both artist and album', async () => {
      const res = await auth
        .get('/library')
        .query({ artist_name: 'Built to Spill', album_title: 'Keep it' })
        .expect(200);

      expectArray(res);
    });

    test('limits results with n parameter', async () => {
      const res = await auth.get('/library').query({ artist_name: 'a', n: 3 }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeLessThanOrEqual(3);
    });

    test('returns 400 when no search parameters provided', async () => {
      const res = await auth.get('/library').expect(400);

      expectErrorContains(res, 'Missing query parameter');
    });

    test('returns empty array when no results found', async () => {
      const res = await auth.get('/library').query({ artist_name: 'xyznonexistentartist123' }).expect(200);

      expectArray(res);
      expect(res.body.length).toBe(0);
    });

    test('code lookup returns 501 (not implemented)', async () => {
      const res = await auth.get('/library').query({ code_letters: 'BUI', code_artist_number: '1' }).expect(501);

      expectErrorContains(res, 'TODO');
    });
  });

  describe('POST /library (Add Album)', () => {
    test('adds album with existing artist_name', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: `Test Album ${Date.now()}`,
          artist_name: 'Built to Spill',
          label: 'Test Label',
          genre_id: 1,
          format_id: 1,
        })
        .expect(200);

      expectFields(res.body, 'id', 'album_title');
      expect(res.body.album_title).toContain('Test Album');
    });

    test('returns 400 when album_title is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          artist_id: 1,
          label: 'Test Label',
          genre_id: 1,
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when label is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          artist_id: 1,
          genre_id: 1,
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when genre_id is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          artist_id: 1,
          label: 'Test Label',
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when format_id is missing', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          artist_id: 1,
          label: 'Test Label',
          genre_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when neither artist_id nor artist_name provided', async () => {
      const res = await auth
        .post('/library')
        .send({
          album_title: 'Test Album',
          label: 'Test Label',
          genre_id: 1,
          format_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });
  });
});

describe('Library Rotation', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/rotation', () => {
    test('returns rotation as an array', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      expectArray(res);
    });

    test('rotation entries have expected fields', async () => {
      const res = await auth.get('/library/rotation').expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'id', 'artist_name', 'album_title', 'rotation_bin', 'rotation_id');
      }
    });
  });

  describe('POST /library/rotation', () => {
    test('adds album to rotation', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({
          album_id: 2,
          rotation_bin: 'M',
        })
        .expect(200);

      expectFields(res.body, 'id', 'album_id', 'rotation_bin');
      expect(res.body.album_id).toBe(2);
      expect(res.body.rotation_bin).toBe('M');

      // Clean up
      if (res.body.id) {
        await auth.patch('/library/rotation').send({ rotation_id: res.body.id });
      }
    });

    test('returns 400 when album_id is missing', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({
          rotation_bin: 'M',
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });

    test('returns 400 when rotation_bin is missing', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({
          album_id: 2,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Parameters');
    });
  });

  describe('PATCH /library/rotation (Kill Rotation)', () => {
    let testRotationId;

    beforeEach(async () => {
      const res = await auth.post('/library/rotation').send({
        album_id: 3,
        rotation_bin: 'L',
      });

      if (res.body && res.body.id) {
        testRotationId = res.body.id;
      }
    });

    test('kills rotation with default date', async () => {
      if (!testRotationId) {
        console.log('Skipping test - no rotation ID available');
        return;
      }

      const res = await auth.patch('/library/rotation').send({ rotation_id: testRotationId }).expect(200);

      expectFields(res.body, 'id', 'kill_date');
      expect(res.body.id).toBe(testRotationId);
    });

    test('kills rotation with specific date', async () => {
      const createRes = await auth.post('/library/rotation').send({
        album_id: 3,
        rotation_bin: 'H',
      });

      if (createRes.body && createRes.body.id) {
        const killDate = '2025-12-31';
        const res = await auth
          .patch('/library/rotation')
          .send({
            rotation_id: createRes.body.id,
            kill_date: killDate,
          })
          .expect(200);

        expect(res.body.kill_date).toBe(killDate);
      }
    });

    test('returns 400 when rotation_id is missing', async () => {
      const res = await auth.patch('/library/rotation').send({}).expect(400);

      expectErrorContains(res, 'Missing Parameter');
    });

    test('returns 400 with invalid date format', async () => {
      const res = await auth
        .patch('/library/rotation')
        .send({
          rotation_id: 1,
          kill_date: '12/31/2025',
        })
        .expect(400);

      expectErrorContains(res, 'Incorrect Date Format');
    });
  });
});

describe('Library Artists', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('POST /library/artists', () => {
    test('adds new artist', async () => {
      const uniqueSuffix = Date.now().toString(36).toUpperCase().slice(-2);
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: `Test Artist ${uniqueSuffix}`,
          code_letters: uniqueSuffix,
          genre_id: 1,
        })
        .expect(200);

      expectFields(res.body, 'id', 'artist_name', 'code_letters', 'code_artist_number');
      expect(res.body.artist_name).toContain('Test Artist');
      expect(res.body.code_letters).toBe(uniqueSuffix);
    });

    test('generates incremented code_artist_number', async () => {
      const uniqueCode = Date.now().toString(36).toUpperCase().slice(-2);

      const res1 = await auth.post('/library/artists').send({
        artist_name: `Test Artist A ${uniqueCode}`,
        code_letters: uniqueCode,
        genre_id: 1,
      });

      const res2 = await auth.post('/library/artists').send({
        artist_name: `Test Artist B ${uniqueCode}`,
        code_letters: uniqueCode,
        genre_id: 1,
      });

      if (res1.body.code_artist_number && res2.body.code_artist_number) {
        expect(res2.body.code_artist_number).toBeGreaterThan(res1.body.code_artist_number);
      }
    });

    test('returns 400 when artist_name is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          code_letters: 'TS',
          genre_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });

    test('returns 400 when code_letters is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: 'Test Artist',
          genre_id: 1,
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });

    test('returns 400 when genre_id is missing', async () => {
      const res = await auth
        .post('/library/artists')
        .send({
          artist_name: 'Test Artist',
          code_letters: 'TS',
        })
        .expect(400);

      expectErrorContains(res, 'Missing Request Parameters');
    });
  });
});

describe('Library Formats', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/formats', () => {
    test('returns formats as an array', async () => {
      const res = await auth.get('/library/formats').expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('formats have expected fields', async () => {
      const res = await auth.get('/library/formats').expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'id', 'format_name');
      }
    });
  });

  describe('POST /library/formats', () => {
    test('adds new format', async () => {
      const uniqueSuffix = Date.now();
      const res = await auth
        .post('/library/formats')
        .send({
          name: `Test Format ${uniqueSuffix}`,
        })
        .expect(200);

      expectFields(res.body, 'id', 'format_name');
      expect(res.body.format_name).toContain('Test Format');
    });

    test('returns 400 when name is missing', async () => {
      const res = await auth.post('/library/formats').send({}).expect(400);

      expectErrorContains(res, 'Missing Parameter');
    });
  });
});

describe('Library Genres', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/genres', () => {
    test('returns genres as an array', async () => {
      const res = await auth.get('/library/genres').expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('genres have expected fields', async () => {
      const res = await auth.get('/library/genres').expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'id', 'genre_name');
      }
    });
  });

  describe('POST /library/genres', () => {
    test('adds new genre', async () => {
      const uniqueSuffix = Date.now();
      const res = await auth
        .post('/library/genres')
        .send({
          name: `Test Genre ${uniqueSuffix}`,
          description: 'A test genre for integration testing',
        })
        .expect(200);

      expectFields(res.body, 'id', 'genre_name');
      expect(res.body.genre_name).toContain('Test Genre');
    });

    test('returns 400 when name is missing', async () => {
      const res = await auth
        .post('/library/genres')
        .send({
          description: 'Test description',
        })
        .expect(400);

      expectErrorContains(res, 'name and description are required');
    });

    test('returns 400 when description is missing', async () => {
      const res = await auth
        .post('/library/genres')
        .send({
          name: 'Test Genre',
        })
        .expect(400);

      expectErrorContains(res, 'name and description are required');
    });
  });
});

describe('Library Album Info', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('GET /library/info', () => {
    test('returns album info for valid album_id', async () => {
      const res = await auth.get('/library/info').query({ album_id: 1 }).expect(200);

      expectFields(res.body, 'id', 'artist_name', 'album_title');
      expect(res.body.id).toBe(1);
    });

    test('returns album with all expected fields', async () => {
      const res = await auth.get('/library/info').query({ album_id: 1 }).expect(200);

      expectFields(res.body, 'id', 'artist_name', 'album_title', 'code_letters', 'code_number', 'plays');
    });

    test('returns 400 when album_id is missing', async () => {
      const res = await auth.get('/library/info').expect(400);

      expectErrorContains(res, 'missing album identifier');
    });

    test('returns undefined/empty for non-existent album_id', async () => {
      const res = await auth.get('/library/info').query({ album_id: 999999 }).expect(200);

      expect(res.body).toBeFalsy();
    });
  });
});
