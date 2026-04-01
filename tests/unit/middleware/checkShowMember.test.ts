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

  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = {
    status: statusMock,
    json: jsonMock,
    locals: {},
  } as unknown as Response;

  const next = jest.fn() as unknown as NextFunction;

  return { req, res, next, statusMock, jsonMock };
}

describe('showMemberMiddleware', () => {
  const originalAuthBypass = process.env.AUTH_BYPASS;

  beforeEach(() => {
    delete process.env.AUTH_BYPASS;
  });

  afterAll(() => {
    if (originalAuthBypass !== undefined) {
      process.env.AUTH_BYPASS = originalAuthBypass;
    }
  });

  it('rejects a DJ who is not in the current show', async () => {
    mockGetDJsInCurrentShow.mockResolvedValue([{ id: 'dj-alice' }, { id: 'dj-bob' }]);

    const { req, res, next, statusMock, jsonMock } = createMockReqResNext('dj-charlie');

    await showMemberMiddleware(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      message: 'Bad Request: DJ not a member of show',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a DJ who is in the current show', async () => {
    mockGetDJsInCurrentShow.mockResolvedValue([{ id: 'dj-alice' }, { id: 'dj-bob' }]);

    const { req, res, next, statusMock } = createMockReqResNext('dj-alice');

    await showMemberMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('rejects when there are no DJs in the current show', async () => {
    mockGetDJsInCurrentShow.mockResolvedValue([]);

    const { req, res, next, statusMock } = createMockReqResNext('dj-alice');

    await showMemberMiddleware(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next(error) when getDJsInCurrentShow throws', async () => {
    const dbError = new Error('DB connection lost');
    mockGetDJsInCurrentShow.mockRejectedValue(dbError);

    const { req, res, next, statusMock } = createMockReqResNext('dj-alice');

    await showMemberMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(statusMock).not.toHaveBeenCalled();
  });
});
