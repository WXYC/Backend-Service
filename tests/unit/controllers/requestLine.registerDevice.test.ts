import { registerDevice } from '../../../apps/backend/controllers/requestLine.controller';
import type { Request, Response } from 'express';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    originalUrl: '/request/register',
    ip: '127.0.0.1',
    get: jest.fn().mockReturnValue('test-agent'),
    body: { deviceId: 'some-device-id' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('registerDevice', () => {
  const originalEnv = process.env.BETTER_AUTH_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BETTER_AUTH_URL = originalEnv;
    } else {
      delete process.env.BETTER_AUTH_URL;
    }
  });

  it('returns 410 Gone for the deprecated endpoint', async () => {
    process.env.BETTER_AUTH_URL = 'https://api.wxyc.org/auth';

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await registerDevice(req, res as unknown as Response, next);

    expect(res._status).toBe(410);
  });

  it('includes deprecation message and replacement endpoint', async () => {
    process.env.BETTER_AUTH_URL = 'https://api.wxyc.org/auth';

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await registerDevice(req, res as unknown as Response, next);

    expect(res._json).toEqual({
      message: 'This endpoint is deprecated. Use POST /auth/sign-in/anonymous for registration.',
      endpoint: 'https://api.wxyc.org/auth/sign-in/anonymous',
    });
  });

  it('falls back to localhost auth URL when BETTER_AUTH_URL is unset', async () => {
    delete process.env.BETTER_AUTH_URL;

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await registerDevice(req, res as unknown as Response, next);

    expect(res._status).toBe(410);
    expect((res._json as { endpoint: string }).endpoint).toBe(
      'http://localhost:8082/auth/sign-in/anonymous'
    );
  });
});
