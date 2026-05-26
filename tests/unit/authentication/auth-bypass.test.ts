import { jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

// Mock better-auth modules to avoid ESM import issues
jest.mock('better-auth/plugins/access', () => ({
  createAccessControl: () => ({
    newRole: (statements: any) => ({
      authorize: () => ({ success: true }),
      statements,
    }),
  }),
}));

jest.mock('better-auth/plugins/organization/access', () => ({
  adminAc: { statements: {} },
  defaultStatements: {},
}));

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn().mockReturnValue(jest.fn()),
  jwtVerify: jest.fn(),
}));

// Set required env vars before importing the module
process.env.BETTER_AUTH_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://auth.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'test-audience';

import { requirePermissions } from '../../../shared/authentication/src/auth.middleware';

describe('AUTH_BYPASS environment variable', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockReq = {
      headers: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis() as any,
      json: jest.fn().mockReturnThis() as any,
    };
    mockNext = jest.fn();
  });

  afterEach(() => {
    delete process.env.AUTH_BYPASS;
    delete process.env.NODE_ENV;
  });

  it('should NOT bypass auth in production even when AUTH_BYPASS is true', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'production';

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('should allow bypass in NODE_ENV=test when AUTH_BYPASS is true', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'test';
    mockReq.headers = { authorization: 'Bearer test-user-id' };

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should allow bypass in NODE_ENV=development when AUTH_BYPASS is true', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'development';
    mockReq.headers = { authorization: 'Bearer test-user-id' };

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should NOT bypass when NODE_ENV is unset (default-safe)', async () => {
    process.env.AUTH_BYPASS = 'true';
    delete process.env.NODE_ENV;
    mockReq.headers = { authorization: 'Bearer test-user-id' };

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).not.toHaveBeenCalled();
    // Bypass declined → falls through to JWKS verify, which fails on the
    // raw "test-user-id" token (not a JWT) and returns 401.
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('should NOT bypass when NODE_ENV is a non-allowed value (e.g. "staging")', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'staging';
    mockReq.headers = { authorization: 'Bearer test-user-id' };

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('should reject requests without auth header even in bypass mode', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'test';

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('should NOT bypass when AUTH_BYPASS is not set', async () => {
    delete process.env.AUTH_BYPASS;
    process.env.NODE_ENV = 'test';

    const middleware = requirePermissions({ flowsheet: ['read'] });
    await middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });
});
