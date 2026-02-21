import { jest } from '@jest/globals';

const mockGetLatestShow = jest.fn();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
}));

jest.mock('../../../apps/backend/services/metadata/index', () => ({
  fetchAndCacheMetadata: jest.fn(),
}));

jest.mock('async-mutex', () => ({
  Mutex: jest.fn().mockImplementation(() => ({
    acquire: jest.fn().mockResolvedValue(jest.fn()),
  })),
}));

import { leaveShow } from '../../../apps/backend/controllers/flowsheet.controller';
import type { Request, Response, NextFunction } from 'express';

function createMockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res as Response;
}

describe('leaveShow', () => {
  it('returns 400 when no active show session exists (end_time is set)', async () => {
    mockGetLatestShow.mockResolvedValue({
      id: 1,
      primary_dj_id: 'dj-1',
      start_time: new Date('2025-01-01'),
      end_time: new Date('2025-01-01T02:00:00'),
    });

    const req = { body: { dj_id: 'dj-1' } } as Request;
    const res = createMockRes();
    const next = jest.fn() as unknown as NextFunction;

    await leaveShow(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Bad Request: No active show session found.',
    });
  });
});
