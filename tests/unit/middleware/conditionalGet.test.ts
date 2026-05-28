import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock the flowsheet service before importing the middleware. The middleware
// reads `getLastModifiedAt()` (an async DB query post-BS#902) and we want to
// drive each test by what the DB returns, not how the service is implemented.
const mockGetLastModifiedAt = jest.fn<() => Promise<Date>>();
jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLastModifiedAt: mockGetLastModifiedAt,
}));

import { conditionalGet } from '../../../apps/backend/middleware/conditionalGet.js';

describe('conditionalGet middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock<NextFunction>;
  let resHeaders: Record<string, string>;
  let statusCode: number | undefined;
  let endCalled: boolean;

  beforeEach(() => {
    mockGetLastModifiedAt.mockReset();
    resHeaders = {};
    statusCode = undefined;
    endCalled = false;
    req = {
      query: {},
      get: jest.fn<(name: string) => string | undefined>().mockReturnValue(undefined),
    };
    res = {
      status: jest.fn((code: number) => {
        statusCode = code;
        return res;
      }) as unknown as Response['status'],
      end: jest.fn(() => {
        endCalled = true;
        return res;
      }) as unknown as Response['end'],
      set: jest.fn((name: string, value: string) => {
        resHeaders[name] = value;
        return res;
      }) as unknown as Response['set'],
    };
    next = jest.fn();
  });

  it('queries getLastModifiedAt and calls next when no If-Modified-Since is set', async () => {
    const dbMax = new Date('2026-01-01T12:00:00.000Z');
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);

    await conditionalGet(req as Request, res as Response, next);

    expect(mockGetLastModifiedAt).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(resHeaders['Last-Modified']).toBe(dbMax.toUTCString());
    expect(statusCode).toBeUndefined();
  });

  it('returns 304 when If-Modified-Since header equals DB max at second granularity', async () => {
    const dbMax = new Date('2026-01-01T12:00:00.000Z');
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);
    (req.get as jest.Mock).mockImplementation((name: unknown) =>
      (name as string) === 'If-Modified-Since' ? dbMax.toUTCString() : undefined
    );

    await conditionalGet(req as Request, res as Response, next);

    expect(statusCode).toBe(304);
    expect(endCalled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 304 when If-Modified-Since is strictly newer than DB max', async () => {
    const dbMax = new Date('2026-01-01T12:00:00.000Z');
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);
    const future = new Date(dbMax.getTime() + 5000);
    (req.get as jest.Mock).mockImplementation((name: unknown) =>
      (name as string) === 'If-Modified-Since' ? future.toUTCString() : undefined
    );

    await conditionalGet(req as Request, res as Response, next);

    expect(statusCode).toBe(304);
    expect(endCalled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 200 (next) when If-Modified-Since is older than DB max', async () => {
    const dbMax = new Date('2026-01-01T12:00:05.000Z');
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);
    const stale = new Date(dbMax.getTime() - 5000);
    (req.get as jest.Mock).mockImplementation((name: unknown) =>
      (name as string) === 'If-Modified-Since' ? stale.toUTCString() : undefined
    );

    await conditionalGet(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(resHeaders['Last-Modified']).toBe(dbMax.toUTCString());
    expect(statusCode).not.toBe(304);
  });

  it('floors both sides to whole seconds: a sub-second-newer DB max still 304s', async () => {
    // HTTP Date precision is whole seconds. The DB trigger gives ms
    // precision; the middleware must floor both sides so a within-second
    // bump doesn't trip a redundant 200.
    const clientStr = 'Thu, 01 Jan 2026 12:00:00 GMT';
    const clientTime = new Date(clientStr);
    const dbMax = new Date(clientTime.getTime() + 500); // 0.5s later
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);
    (req.get as jest.Mock).mockImplementation((name: unknown) =>
      (name as string) === 'If-Modified-Since' ? clientStr : undefined
    );

    await conditionalGet(req as Request, res as Response, next);

    expect(statusCode).toBe(304);
    expect(endCalled).toBe(true);
  });

  it('prefers the `since` query param over the If-Modified-Since header', async () => {
    const dbMax = new Date('2026-01-01T12:00:00.000Z');
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);
    req.query = { since: dbMax.toISOString() };
    (req.get as jest.Mock).mockImplementation((name: unknown) =>
      (name as string) === 'If-Modified-Since'
        ? // Stale header should be ignored in favor of the param.
          new Date(dbMax.getTime() - 60_000).toUTCString()
        : undefined
    );

    await conditionalGet(req as Request, res as Response, next);

    expect(statusCode).toBe(304);
    expect(endCalled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through when the since param is unparseable (NaN guard)', async () => {
    const dbMax = new Date('2026-01-01T12:00:00.000Z');
    mockGetLastModifiedAt.mockResolvedValueOnce(dbMax);
    req.query = { since: 'not-a-date' };

    await conditionalGet(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(statusCode).not.toBe(304);
    expect(resHeaders['Last-Modified']).toBe(dbMax.toUTCString());
  });
});
