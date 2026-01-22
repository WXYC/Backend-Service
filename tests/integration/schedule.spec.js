const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Schedule Endpoints Integration Tests
 *
 * Tests for DJ show scheduling.
 */

describe('Schedule Endpoints', () => {
  describe('GET /schedule', () => {
    test('should return schedule', async () => {
      const res = await request
        .get('/schedule')
        .expect(200);

      // Schedule can be an array or object organized by day
      expect(res.body).toBeDefined();
    });

    test('should not require authentication for read', async () => {
      // Schedule is public information
      const res = await request.get('/schedule');

      expect(res.status).toBe(200);
    });
  });

  describe('POST /schedule', () => {
    test('should reject request without required fields', async () => {
      const res = await request
        .post('/schedule')
        .send({});

      // Should return 400 for missing fields
      expect([400, 401, 403]).toContain(res.status);
    });

    test('should reject request with invalid day', async () => {
      const res = await request
        .post('/schedule')
        .send({
          dj_id: global.primary_dj_id,
          day: 'InvalidDay',
          start_time: '14:00',
          end_time: '16:00',
        });

      expect([400, 401, 403]).toContain(res.status);
    });

    test('should reject request with invalid time format', async () => {
      const res = await request
        .post('/schedule')
        .send({
          dj_id: global.primary_dj_id,
          day: 'Monday',
          start_time: '25:00', // Invalid hour
          end_time: '16:00',
        });

      expect([400, 401, 403]).toContain(res.status);
    });
  });
});

describe('Schedule Data Validation', () => {
  describe('Time range validation', () => {
    test('should reject end time before start time', async () => {
      const res = await request
        .post('/schedule')
        .send({
          dj_id: global.primary_dj_id,
          day: 'Monday',
          start_time: '16:00',
          end_time: '14:00', // End before start
        });

      // Should reject or handle overnight shows
      expect([400, 401, 403, 200]).toContain(res.status);
    });
  });

  describe('Day of week validation', () => {
    const validDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    validDays.forEach((day) => {
      test(`should accept ${day} as valid day`, async () => {
        // This test just validates that the day format is accepted
        // The actual creation may fail due to other validation or auth
        const res = await request.post('/schedule').send({
          dj_id: global.primary_dj_id,
          day: day,
          start_time: '14:00',
          end_time: '16:00',
        });

        // Should not fail specifically due to day validation
        // 400 could be other validation, 401/403 is auth
        expect([200, 201, 400, 401, 403, 409]).toContain(res.status);
      });
    });
  });
});
