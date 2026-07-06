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
export { resolveCorsOrigin } from '../../shared/authentication/src/cors-origin';
export type { ResolvedCorsOrigin } from '../../shared/authentication/src/cors-origin';
