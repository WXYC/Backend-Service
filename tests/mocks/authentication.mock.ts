import { Request, Response, NextFunction } from 'express';

/**
 * Minimal mock for @wxyc/authentication workspace package.
 * Tests that need auth should provide their own jest.mock() factory.
 */
export const auth = {
  api: {
    getSession: () => Promise.resolve(null),
  },
};

export function requirePermissions(_required: Record<string, string[]>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized: Missing Authorization header.' });
    }
    return next();
  };
}

// Real implementation, not a stub: `resolveCorsOrigin` is pure env parsing
// with no auth/database dependencies, so consumers under unit test get the
// production behavior (BS#1107).
export {
  PUBLIC_READ_CORS_ROUTES,
  isPublicReadGrant,
  resolveCorsOrigin,
  resolvePublicCorsOrigins,
} from '../../shared/authentication/src/cors-origin';

// Real implementation for the same reason as `resolveCorsOrigin` above:
// `parseBearerToken` is pure string parsing with no auth/database dependency,
// and a stub here would let the rate-limit key generator's bearer arm pass
// tests against behavior the production parser doesn't have.
export { parseBearerToken } from '../../shared/authentication/src/auth.middleware';
export type { CorsModeRequest, ResolvedCorsOrigin } from '../../shared/authentication/src/cors-origin';

// Real implementation, same BS#1107 convention: `deriveStationSignupIpHash`
// is pure (env + crypto only, no DB import — that's the whole point of its
// extraction to signup-ip-hash.ts in BS#2537), and the account-audit
// middleware's fail-closed-to-NULL behavior on a missing/invalid key is
// production behavior the unit suite must exercise, not a stub's guess at it.
export { deriveStationSignupIpHash } from '../../shared/authentication/src/signup-ip-hash';
