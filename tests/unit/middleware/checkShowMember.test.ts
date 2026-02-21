import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetDJsInCurrentShow = jest.fn<() => Promise<{ id: string }[]>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getDJsInCurrentShow: mockGetDJsInCurrentShow,
}));

import { showMemberMiddleware } from '../../../apps/backend/middleware/checkShowMember';

function createMockReqResNext(userId: string) {
  const req = {
    auth: { id: userId },
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    locals: {},
  } as unknown as Response;

  const next = jest.fn() as unknown as NextFunction;

  return { req, res, next };
}

describe('showMemberMiddleware', () => {
  it('rejects a DJ who is not in the current show', async () => {
    mockGetDJsInCurrentShow.mockResolvedValue([
      { id: 'dj-alice' },
      { id: 'dj-bob' },
    ]);

    const { req, res, next } = createMockReqResNext('dj-charlie');

    await showMemberMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Bad Request: DJ not a member of show',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a DJ who is in the current show', async () => {
    mockGetDJsInCurrentShow.mockResolvedValue([
      { id: 'dj-alice' },
      { id: 'dj-bob' },
    ]);

    const { req, res, next } = createMockReqResNext('dj-alice');

    await showMemberMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects when there are no DJs in the current show', async () => {
    mockGetDJsInCurrentShow.mockResolvedValue([]);

    const { req, res, next } = createMockReqResNext('dj-alice');

    await showMemberMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when getDJsInCurrentShow throws', async () => {
    mockGetDJsInCurrentShow.mockRejectedValue(new Error('DB connection lost'));

    const { req, res, next } = createMockReqResNext('dj-alice');

    await showMemberMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Internal server error checking show membership',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
