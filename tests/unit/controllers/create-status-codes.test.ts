import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/djs.service');
jest.mock('../../../apps/backend/services/schedule.service');

import * as DJService from '../../../apps/backend/services/djs.service';
import * as ScheduleService from '../../../apps/backend/services/schedule.service';
import { addToBin } from '../../../apps/backend/controllers/djs.controller';
import { addToSchedule } from '../../../apps/backend/controllers/schedule.controller';

function mockReqResNext(body: Record<string, unknown> = {}) {
  const req = { body } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('create endpoints return 201', () => {
  describe('addToBin', () => {
    it('should return 201 when a bin entry is created', async () => {
      const created = { id: 1, dj_id: 'dj-1', album_id: 10, track_title: null };
      (DJService.addToBin as jest.Mock).mockResolvedValue(created);

      const { req, res, next } = mockReqResNext({
        dj_id: 'dj-1',
        album_id: 10,
      });

      await addToBin(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(created);
    });
  });

  describe('addToSchedule', () => {
    it('should return 201 when a schedule entry is created', async () => {
      const created = { id: 1, day: 'Monday', start_time: '10:00', end_time: '12:00' };
      (ScheduleService.addToSchedule as jest.Mock).mockResolvedValue(created);

      const { req, res, next } = mockReqResNext({
        day: 'Monday',
        start_time: '10:00',
        end_time: '12:00',
      });

      await addToSchedule(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(created);
    });
  });
});
