const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { expectFields, expectArray } = require('../utils/test_helpers');

/**
 * Schedule Endpoints Integration Tests
 *
 * Tests for:
 * - GET /schedule - Retrieve full schedule
 * - POST /schedule - Add shift to schedule
 *
 * Note: Schedule endpoints don't require authentication
 */

describe('Schedule', () => {
  const createdScheduleIds = [];

  afterAll(async () => {
    // Note: Cleanup would require a DELETE endpoint (currently commented out in route)
  });

  describe('GET /schedule', () => {
    test('returns schedule as an array', async () => {
      const res = await request.get('/schedule').expect(200);

      expectArray(res);
    });

    test('schedule entries have expected fields', async () => {
      const res = await request.get('/schedule').expect(200);

      if (res.body.length > 0) {
        expectFields(res.body[0], 'id', 'day', 'start_time', 'show_duration');
      }
    });

    test('day field contains valid values (0-6)', async () => {
      const res = await request.get('/schedule').expect(200);

      res.body.forEach((shift) => {
        expect(shift.day).toBeGreaterThanOrEqual(0);
        expect(shift.day).toBeLessThanOrEqual(6);
      });
    });
  });

  describe('POST /schedule', () => {
    test('adds shift to schedule successfully', async () => {
      const newShift = {
        day: 0,
        start_time: '14:00:00',
        show_duration: 8,
      };

      const res = await request.post('/schedule').send(newShift).expect(200);

      expectFields(res.body, 'id', 'day', 'start_time', 'show_duration');
      expect(res.body.day).toBe(0);
      expect(res.body.start_time).toBe('14:00:00');
      expect(res.body.show_duration).toBe(8);

      if (res.body.id) {
        createdScheduleIds.push(res.body.id);
      }
    });

    test('adds shift with specialty_id', async () => {
      const newShift = {
        day: 2,
        start_time: '20:00:00',
        show_duration: 4,
        specialty_id: null,
      };

      const res = await request.post('/schedule').send(newShift).expect(200);

      expect(res.body.day).toBe(2);

      if (res.body.id) {
        createdScheduleIds.push(res.body.id);
      }
    });

    test('adds shift on different days of the week', async () => {
      const days = [
        { day: 1, name: 'Tuesday' },
        { day: 3, name: 'Thursday' },
        { day: 4, name: 'Friday' },
        { day: 5, name: 'Saturday' },
        { day: 6, name: 'Sunday' },
      ];

      for (const { day } of days) {
        const newShift = {
          day,
          start_time: '10:00:00',
          show_duration: 4,
        };

        const res = await request.post('/schedule').send(newShift).expect(200);

        expect(res.body.day).toBe(day);

        if (res.body.id) {
          createdScheduleIds.push(res.body.id);
        }
      }
    });

    test('handles various time formats', async () => {
      const newShift = {
        day: 0,
        start_time: '08:30:00',
        show_duration: 2,
      };

      const res = await request.post('/schedule').send(newShift).expect(200);

      expect(res.body.start_time).toBe('08:30:00');

      if (res.body.id) {
        createdScheduleIds.push(res.body.id);
      }
    });

    test('schedule is updated after adding shift', async () => {
      const initialRes = await request.get('/schedule').expect(200);
      const initialCount = initialRes.body.length;

      const newShift = {
        day: 6,
        start_time: '23:00:00',
        show_duration: 4,
      };

      const postRes = await request.post('/schedule').send(newShift).expect(200);

      if (postRes.body.id) {
        createdScheduleIds.push(postRes.body.id);
      }

      const finalRes = await request.get('/schedule').expect(200);

      expect(finalRes.body.length).toBe(initialCount + 1);

      const addedShift = finalRes.body.find((s) => s.id === postRes.body.id);
      expect(addedShift).toBeDefined();
      expect(addedShift.day).toBe(6);
    });
  });
});
