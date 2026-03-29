import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock @sentry/node before importing the middleware
const mockSetTag = jest.fn();
const mockGetCurrentScope = jest.fn().mockReturnValue({ setTag: mockSetTag });
jest.mock('@sentry/node', () => ({
  getCurrentScope: mockGetCurrentScope,
}));

// Mock crypto.randomUUID
const mockRandomUUID = jest.fn<() => string>().mockReturnValue('generated-uuid-1234');
jest.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(mockRandomUUID);

import { requestIdMiddleware } from '../../../apps/backend/middleware/requestId.js';

describe('requestIdMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    req = {
      headers: {},
      get: jest.fn<(name: string) => string | undefined>().mockImplementation((name: string) => {
        return (req.headers as Record<string, string>)?.[name.toLowerCase()];
      }),
    };
    res = {
      setHeader: jest.fn(),
    };
    next = jest.fn();
  });

  it('generates a UUID when no X-Request-Id header is present', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(mockRandomUUID).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'generated-uuid-1234');
    expect(next).toHaveBeenCalled();
  });

  it('passes through an existing X-Request-Id from the request', () => {
    req.headers = { 'x-request-id': 'client-request-id-5678' };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(mockRandomUUID).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-request-id-5678');
    expect(next).toHaveBeenCalled();
  });

  it('sets X-Request-Id on response headers', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', expect.any(String));
  });

  it('tags the current Sentry scope with request_id', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(mockGetCurrentScope).toHaveBeenCalled();
    expect(mockSetTag).toHaveBeenCalledWith('request_id', 'generated-uuid-1234');
  });

  it('tags Sentry scope with client-provided request_id', () => {
    req.headers = { 'x-request-id': 'client-id-9999' };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(mockSetTag).toHaveBeenCalledWith('request_id', 'client-id-9999');
  });
});
