import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetSession = jest.fn<() => Promise<Record<string, unknown> | null>>();
const mockRecordActivity = jest.fn<() => Promise<void>>();

jest.mock('@wxyc/authentication', () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

jest.mock('better-auth/node', () => ({
  fromNodeHeaders: jest.fn((headers: unknown) => headers),
}));

jest.mock('../../../apps/backend/services/activityTracking.service', () => ({
  recordActivity: mockRecordActivity,
}));

import { requireAnonymousAuth } from '../../../apps/backend/middleware/anonymousAuth';

const createMockRes = () => {
  const res: Partial<Response> = { locals: {} };
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
};

const createMockReq = () =>
  ({
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as Request;

describe('requireAnonymousAuth', () => {
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn();
    mockRecordActivity.mockResolvedValue(undefined);
  });

  it('calls next() when session is valid', async () => {
    mockGetSession.mockResolvedValue({
      user: { id: 'user-1', email: 'dj@wxyc.org', name: 'DJ Test' },
    });

    const req = createMockReq();
    const res = createMockRes();

    await requireAnonymousAuth(req, res as Response, mockNext as unknown as NextFunction);

    expect(mockNext).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user?.id).toBe('user-1');
  });

  it('returns 401 when no session exists', async () => {
    mockGetSession.mockResolvedValue(null);

    const req = createMockReq();
    const res = createMockRes();

    await requireAnonymousAuth(req, res as Response, mockNext as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('returns 403 when user is banned', async () => {
    mockGetSession.mockResolvedValue({
      user: { id: 'user-1', email: 'banned@wxyc.org', name: 'Bad DJ', banned: true, banReason: 'spam' },
    });

    const req = createMockReq();
    const res = createMockRes();

    await requireAnonymousAuth(req, res as Response, mockNext as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Access denied', reason: 'spam' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('calls next(error) when getSession throws', async () => {
    const error = new Error('Auth service unreachable');
    mockGetSession.mockRejectedValue(error);

    const req = createMockReq();
    const res = createMockRes();

    await requireAnonymousAuth(req, res as Response, mockNext as unknown as NextFunction);

    expect(mockNext).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not block request when recordActivity fails', async () => {
    mockGetSession.mockResolvedValue({
      user: { id: 'user-1', email: 'dj@wxyc.org', name: 'DJ Test' },
    });
    mockRecordActivity.mockRejectedValue(new Error('Redis down'));

    const req = createMockReq();
    const res = createMockRes();

    await requireAnonymousAuth(req, res as Response, mockNext as unknown as NextFunction);

    expect(mockNext).toHaveBeenCalledWith();
  });
});
