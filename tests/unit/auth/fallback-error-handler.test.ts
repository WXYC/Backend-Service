import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock Sentry so we can assert on captureException invocations without booting
// the SDK. Keep the mock factory variable name prefixed with `mock` so Jest's
// out-of-band hoisting allows the reference (see provision-user.test.ts).
const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

import { fallbackErrorHandler } from '../../../apps/auth/fallback-error-handler';

function mockResponse() {
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = {
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;
  return { res, statusMock, jsonMock };
}

const mockReq = { method: 'POST', url: '/auth/sign-in/username' } as Request;
const mockNext = jest.fn() as NextFunction;

describe('fallbackErrorHandler (BS#1109 sanitisation)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    mockSentryCaptureException.mockClear();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('does not leak SQL fragments in production response body', () => {
    process.env.NODE_ENV = 'production';
    const { res, statusMock, jsonMock } = mockResponse();
    const leakyError = new Error('select * from foo where x = $1 failed: connection refused');

    fallbackErrorHandler(leakyError, mockReq, res, mockNext);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Internal server error' });

    const body = jsonMock.mock.calls[0]?.[0] as { error: string };
    expect(body.error).not.toMatch(/select/i);
    expect(body.error).not.toContain('foo');
    expect(body.error).not.toContain('$1');
    expect(body.error).not.toContain('connection refused');
  });

  it('always forwards the full error to Sentry, even in production', () => {
    process.env.NODE_ENV = 'production';
    const { res } = mockResponse();
    const leakyError = new Error('select * from foo where x = $1 failed: connection refused');

    fallbackErrorHandler(leakyError, mockReq, res, mockNext);

    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(leakyError);
  });

  it('preserves the detailed message in development for debugging', () => {
    process.env.NODE_ENV = 'development';
    const { res, statusMock, jsonMock } = mockResponse();
    const error = new Error('detailed dev message');

    fallbackErrorHandler(error, mockReq, res, mockNext);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'detailed dev message' });
    expect(mockSentryCaptureException).toHaveBeenCalledWith(error);
  });

  it('preserves the detailed message in test environment', () => {
    process.env.NODE_ENV = 'test';
    const { res, jsonMock } = mockResponse();
    const error = new Error('test-env message');

    fallbackErrorHandler(error, mockReq, res, mockNext);

    expect(jsonMock).toHaveBeenCalledWith({ error: 'test-env message' });
  });

  it('treats unset NODE_ENV as non-production (dev-server convenience)', () => {
    // The sanitisation gate is positive-list on `=== 'production'`, so an
    // unset NODE_ENV falls into the dev branch and returns the detailed
    // message. Production deploys always set NODE_ENV, so this only matters
    // for local `node app.js` invocations. The acceptance criterion (no
    // leak when NODE_ENV === 'production') is covered above.
    delete process.env.NODE_ENV;
    const { res, jsonMock } = mockResponse();
    const error = new Error('would-be-leaky message');

    fallbackErrorHandler(error, mockReq, res, mockNext);

    expect(jsonMock).toHaveBeenCalledWith({ error: 'would-be-leaky message' });
  });

  it('handles non-Error throws (string, undefined) without crashing', () => {
    process.env.NODE_ENV = 'production';
    const { res, jsonMock } = mockResponse();

    fallbackErrorHandler('something broke', mockReq, res, mockNext);

    expect(jsonMock).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(mockSentryCaptureException).toHaveBeenCalledWith('something broke');
  });
});
