/* eslint-disable @typescript-eslint/unbound-method */
// Set required env vars before module load (ts-jest transforms imports to requires,
// so these execute before the middleware module's top-level code runs)
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';

// Mock jose -- the middleware calls createRemoteJWKSet at module scope
// and jwtVerify on each request. decodeJwt is used in AUTH_BYPASS mode.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

import { jwtVerify, decodeJwt } from 'jose';
import { requirePermissions } from '../../../shared/authentication/src/auth.middleware';
import type { Request, Response, NextFunction } from 'express';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockedDecodeJwt = decodeJwt as jest.MockedFunction<typeof decodeJwt>;

function createMocks(authHeader?: string) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;

  const next = jest.fn() as NextFunction;

  return { req, res, next };
}

function mockJwtPayload(overrides: Record<string, unknown> = {}) {
  mockedJwtVerify.mockResolvedValue({
    payload: {
      sub: 'test-user-id',
      email: 'test@wxyc.org',
      role: 'dj',
      ...overrides,
    },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  } as any);
}

describe('requirePermissions middleware', () => {
  const originalAuthBypass = process.env.AUTH_BYPASS;

  beforeEach(() => {
    delete process.env.AUTH_BYPASS;
  });

  afterAll(() => {
    if (originalAuthBypass !== undefined) {
      process.env.AUTH_BYPASS = originalAuthBypass;
    } else {
      delete process.env.AUTH_BYPASS;
    }
  });

  describe('AUTH_BYPASS', () => {
    beforeEach(() => {
      process.env.AUTH_BYPASS = 'true';
    });

    it('should skip all validation when AUTH_BYPASS is "true"', async () => {
      const { req, res, next } = createMocks();
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should populate req.auth from decoded JWT when token is a valid JWT', async () => {
      mockedDecodeJwt.mockReturnValue({
        sub: 'jwt-user-id',
        email: 'test@wxyc.org',
        role: 'dj',
      } as any);
      const { req, res, next } = createMocks('Bearer some.jwt.token');
      const middleware = requirePermissions({ bin: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.auth?.id).toBe('jwt-user-id');
    });

    it('should use raw token as user ID when token is not a valid JWT', async () => {
      mockedDecodeJwt.mockImplementation(() => {
        throw new Error('Invalid token');
      });
      const userId = 'abc-123-user-id';
      const { req, res, next } = createMocks(`Bearer ${userId}`);
      const middleware = requirePermissions({ bin: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.auth?.id).toBe(userId);
    });
  });

  describe('token validation', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const { req, res, next } = createMocks();
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when JWT verification fails', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      mockedJwtVerify.mockRejectedValue(new Error('invalid signature'));
      const { req, res, next } = createMocks('Bearer bad-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('role normalization', () => {
    /**
     * Regression test for the 403 bug. Before this fix, WXYCRoles did not
     * include "admin" or "owner". When better-auth assigned one of those
     * roles to a user's JWT, the middleware returned 403 "Invalid role".
     *
     * The fix normalizes system roles to their WXYC equivalents instead of
     * adding them as separate roles.
     */
    it('should normalize "admin" to stationManager and pass through', async () => {
      mockJwtPayload({ role: 'admin' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.auth?.role).toBe('stationManager');
    });

    it('should normalize "owner" to stationManager and pass through', async () => {
      mockJwtPayload({ role: 'owner' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.auth?.role).toBe('stationManager');
    });

    it('should pass through "dj" role unchanged', async () => {
      mockJwtPayload({ role: 'dj' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ flowsheet: ['write'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.auth?.role).toBe('dj');
    });

    it('should return 403 for an unrecognized role', async () => {
      mockJwtPayload({ role: 'nonexistent_role' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid role') })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when role is missing from token', async () => {
      mockJwtPayload({ role: undefined });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('permission checks', () => {
    it.each(['member', 'dj', 'musicDirector', 'stationManager'] as const)(
      '"%s" should be authorized for catalog:read',
      async (role) => {
        mockJwtPayload({ role });
        const { req, res, next } = createMocks('Bearer valid-token');
        const middleware = requirePermissions({ catalog: ['read'] });

        await middleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      }
    );

    it('should return 403 when role lacks required permission', async () => {
      mockJwtPayload({ role: 'member' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['write'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('insufficient permissions'),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('normalized admin should have stationManager permissions (catalog:write)', async () => {
      mockJwtPayload({ role: 'admin' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['write'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('normalized owner should have stationManager permissions (flowsheet:write)', async () => {
      mockJwtPayload({ role: 'owner' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ flowsheet: ['write'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});
