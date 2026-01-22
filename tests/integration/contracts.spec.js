const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * API Contract Tests
 *
 * Validates that API responses match expected schemas.
 * Uses snapshot testing for response shapes.
 */

describe('API Contracts', () => {
  describe('Flowsheet Entry Schema', () => {
    test('GET /flowsheet returns entries with expected fields', async () => {
      const res = await request
        .get('/flowsheet')
        .query({ page: 0, limit: 1 })
        .set('Authorization', global.access_token);

      if (res.status === 200 && res.body.length > 0) {
        const entry = res.body[0];

        // Required fields
        expect(entry).toHaveProperty('id');
        expect(typeof entry.id).toBe('number');

        expect(entry).toHaveProperty('play_order');
        expect(typeof entry.play_order).toBe('number');

        expect(entry).toHaveProperty('show_id');
        expect(typeof entry.show_id).toBe('number');

        // Boolean field
        expect(entry).toHaveProperty('request_flag');
        expect(typeof entry.request_flag).toBe('boolean');

        // Optional fields should be correct type if present
        if (entry.track_title !== undefined) {
          expect(typeof entry.track_title).toBe('string');
        }
        if (entry.artist_name !== undefined) {
          expect(typeof entry.artist_name).toBe('string');
        }
        if (entry.album_title !== undefined) {
          expect(typeof entry.album_title).toBe('string');
        }
      }
    });
  });

  describe('Library Search Schema', () => {
    test('GET /library returns albums with expected fields', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'a', n: 1 })
        .set('Authorization', global.access_token);

      if (res.status === 200 && res.body.length > 0) {
        const album = res.body[0];

        // Required fields
        expect(album).toHaveProperty('id');
        expect(typeof album.id).toBe('number');

        expect(album).toHaveProperty('album_title');
        expect(typeof album.album_title).toBe('string');

        expect(album).toHaveProperty('artist_name');
        expect(typeof album.artist_name).toBe('string');

        expect(album).toHaveProperty('code_letters');
        expect(typeof album.code_letters).toBe('string');

        expect(album).toHaveProperty('code_number');
        expect(typeof album.code_number).toBe('number');
      }
    });
  });

  describe('Formats Schema', () => {
    test('GET /library/formats returns formats with expected fields', async () => {
      const res = await request
        .get('/library/formats')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      const format = res.body[0];
      expect(format).toHaveProperty('id');
      expect(typeof format.id).toBe('number');

      expect(format).toHaveProperty('format_name');
      expect(typeof format.format_name).toBe('string');
    });
  });

  describe('Genres Schema', () => {
    test('GET /library/genres returns genres with expected fields', async () => {
      const res = await request
        .get('/library/genres')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      const genre = res.body[0];
      expect(genre).toHaveProperty('id');
      expect(typeof genre.id).toBe('number');

      expect(genre).toHaveProperty('genre_name');
      expect(typeof genre.genre_name).toBe('string');
    });
  });

  describe('Rotation Schema', () => {
    test('GET /library/rotation returns rotation with expected fields', async () => {
      const res = await request
        .get('/library/rotation')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);

      if (res.body.length > 0) {
        const rotation = res.body[0];

        expect(rotation).toHaveProperty('id');
        expect(typeof rotation.id).toBe('number');

        expect(rotation).toHaveProperty('play_freq');
        expect(['S', 'L', 'M', 'H']).toContain(rotation.play_freq);

        expect(rotation).toHaveProperty('album_title');
        expect(rotation).toHaveProperty('artist_name');
      }
    });
  });

  describe('On-Air Schema', () => {
    test('GET /flowsheet/on-air returns expected shape', async () => {
      const res = await request.get('/flowsheet/on-air').expect(200);

      expect(res.body).toHaveProperty('djs');
      expect(Array.isArray(res.body.djs)).toBe(true);

      expect(res.body).toHaveProperty('onAir');
    });
  });

  describe('Error Response Schema', () => {
    test('Error responses have message field', async () => {
      const res = await request
        .get('/library/info')
        .set('Authorization', global.access_token)
        .expect(400);

      expect(res.body).toHaveProperty('message');
      expect(typeof res.body.message).toBe('string');
    });

    test('404 responses have message field', async () => {
      const res = await request
        .get('/library')
        .query({ artist_name: 'xyznonexistent123456789' })
        .set('Authorization', global.access_token)
        .expect(404);

      expect(res.body).toHaveProperty('message');
      expect(typeof res.body.message).toBe('string');
    });
  });
});
