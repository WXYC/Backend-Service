import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/djs.service', () => ({
  addToBin: jest.fn().mockResolvedValue({ id: 1, dj_id: 'user-A', album_id: 1, track_title: null } as never),
  removeFromBin: jest.fn().mockResolvedValue({ id: 1, dj_id: 'user-A', album_id: 1, track_title: null } as never),
  getBinFromDB: jest.fn().mockResolvedValue([] as never),
}));

import * as DJService from '../../../apps/backend/services/djs.service';
import { addToBin, deleteFromBin, getBin } from '../../../apps/backend/controllers/djs.controller';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.send = jest.fn().mockReturnValue(res) as unknown as Response['send'];
  return res;
}

const next: NextFunction = jest.fn();

describe('djs.controller bin endpoints – IDOR protection', () => {
  describe('addToBin', () => {
    it('uses authenticated user ID, not client-supplied dj_id', async () => {
      const req = {
        auth: { id: 'user-A' },
        body: { dj_id: 'user-B', album_id: 1 },
      } as unknown as Request;

      await addToBin(req, mockResponse(), next);

      expect(DJService.addToBin).toHaveBeenCalledWith(
        expect.objectContaining({ dj_id: 'user-A' })
      );
    });
  });

  describe('deleteFromBin', () => {
    it('uses authenticated user ID, not client-supplied dj_id', async () => {
      const req = {
        auth: { id: 'user-A' },
        query: { dj_id: 'user-B', album_id: '1' },
      } as unknown as Request;

      await deleteFromBin(req, mockResponse(), next);

      expect(DJService.removeFromBin).toHaveBeenCalledWith(1, 'user-A');
    });
  });

  describe('getBin', () => {
    it('uses authenticated user ID, not client-supplied dj_id', async () => {
      const req = {
        auth: { id: 'user-A' },
        query: { dj_id: 'user-B' },
      } as unknown as Request;

      await getBin(req, mockResponse(), next);

      expect(DJService.getBinFromDB).toHaveBeenCalledWith('user-A');
    });
  });
});
