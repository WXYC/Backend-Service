// Set required env vars before module load (ts-jest transforms imports to requires,
// so these execute before the middleware module's top-level code runs)
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';

// Mock jose — the middleware calls createRemoteJWKSet at module scope
// and jwtVerify on each request
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));

import { jwtVerify } from 'jose';
import { requirePermissions } from '../../../shared/authentication/src/auth.middleware';
import type { Request, Response, NextFunction } from 'express';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

/** Build minimal Express req/res/next mocks */
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
    it('should skip all validation when AUTH_BYPASS is "true"', async () => {
      process.env.AUTH_BYPASS = 'true';
      const { req, res, next } = createMocks(); // no auth header
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
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
      jest.spyOn(console, 'error').mockImplementation(() => {}); // suppress expected log
      mockedJwtVerify.mockRejectedValue(new Error('invalid signature'));
      const { req, res, next } = createMocks('Bearer bad-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('role validation', () => {
    it('should return 403 "Invalid role" for an unrecognized role', async () => {
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

    /**
     * This is the exact regression test for Jackson's 403 bug.
     *
     * Before the fix, WXYCRoles did not include "admin". When better-auth
     * assigned role="admin" to a user's JWT (via org hooks / syncAdminRoles),
     * the middleware hit line 106-107:
     *
     *   const roleImpl = WXYCRoles[payload.role]; // undefined
     *   if (!roleImpl) return res.status(403)      // 403 "Invalid role"
     *
     * With the fix, WXYCRoles.admin is defined, so the middleware proceeds.
     */
    it('should NOT return 403 for the "admin" role', async () => {
      mockJwtPayload({ role: 'admin' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['read'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('permission checks', () => {
    it.each(['member', 'dj', 'musicDirector', 'stationManager', 'admin'] as const)(
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

    it('should return 403 "insufficient permissions" when role lacks required permission', async () => {
      mockJwtPayload({ role: 'member' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['write'] });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('insufficient permissions') })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('admin should be authorized for flowsheet:write', async () => {
      mockJwtPayload({ role: 'admin' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ flowsheet: ['write'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('admin should be authorized for catalog:write', async () => {
      mockJwtPayload({ role: 'admin' });
      const { req, res, next } = createMocks('Bearer valid-token');
      const middleware = requirePermissions({ catalog: ['write'] });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});
