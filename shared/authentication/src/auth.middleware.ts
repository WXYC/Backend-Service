import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import { AccessControlStatement, WXYCRole, WXYCRoles, normalizeRole } from './auth.roles';

// JWT payload structure expected from better-auth JWT plugin
// When used with organization plugin, tokens include user info and organization role
// Standard JWT fields: 'sub' (user ID), 'email'
// Organization plugin adds: organization context with member role
export type WXYCAuthJwtPayload = JWTPayload & {
  id?: string; // User ID (may be in 'sub' field, better-auth may map it)
  sub?: string; // Standard JWT subject (user ID)
  email: string;
  role?: WXYCRole; // Organization member role (absent for anonymous users)
  banned?: boolean;
  banReason?: string | null;
};

// Lazily initialized on first use so that importing this module from the auth
// service (which only needs the `auth` instance, not `requirePermissions`)
// doesn't throw when BETTER_AUTH_JWKS_URL is absent.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!_jwks) {
    const jwksUrl = process.env.BETTER_AUTH_JWKS_URL;
    if (!jwksUrl) {
      throw new Error('BETTER_AUTH_JWKS_URL environment variable is not set.');
    }
    _jwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  return _jwks;
}

async function verify(token: string) {
  const issuer = process.env.BETTER_AUTH_ISSUER;
  const audience = process.env.BETTER_AUTH_AUDIENCE;

  if (!issuer || !audience) {
    throw new Error('JWT verification environment variables are not properly set.');
  }

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: issuer,
      audience: audience,
    });

    return payload as WXYCAuthJwtPayload;
  } catch (error) {
    throw new Error(`JWT verification failed: ${error}`);
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: Awaited<ReturnType<typeof verify>>;
  }
}

export type RequiredPermissions = {
  [K in keyof AccessControlStatement]?: AccessControlStatement[K][number][];
};

export function requirePermissions(required: RequiredPermissions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production') {
      // In bypass mode, skip JWKS signature verification but still enforce
      // the same request structure as production: require a Bearer token.
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized: Missing Authorization header.' });
      }
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return res.status(401).json({ error: 'Unauthorized: Missing token in Authorization header.' });
      }
      const token = match[1].trim();
      // Try to decode the JWT so req.auth is populated for controllers.
      // If the token is not a valid JWT (e.g. integration tests pass a raw
      // user ID), fall back to using the token value as the user ID directly.
      try {
        const payload = decodeJwt(token) as WXYCAuthJwtPayload;
        const userId = payload.id || payload.sub;
        if (userId) {
          req.auth = { ...payload, id: userId } as WXYCAuthJwtPayload;
        }
      } catch {
        req.auth = { id: token } as WXYCAuthJwtPayload;
      }
      return next();
    }

    // Extract Bearer token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized: Missing Authorization header.' });
    }

    // Extract token from Authorization header
    // Support both "Bearer <token>" and plain "<token>" formats
    // Tests may use plain format, but Bearer format is standard
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Missing token in Authorization header.' });
    }

    // Verify JWT using JWKS from better-auth service
    let payload: WXYCAuthJwtPayload;
    try {
      payload = await verify(token);
    } catch (error) {
      console.error('JWT verification failed:', error);
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
    }

    // Normalize user ID - JWT standard uses 'sub', but better-auth may also include 'id'
    const userId = payload.id || payload.sub;
    if (!userId) {
      return res.status(403).json({ error: 'Forbidden: Missing user ID in token.' });
    }

    // Attach authenticated payload to request (ensure id field is set)
    req.auth = {
      ...payload,
      id: userId,
    } as WXYCAuthJwtPayload;

    // Check if user is banned (field is included in JWT payload via ...user spread)
    if (payload.banned) {
      return res.status(403).json({
        message: 'Access denied',
        reason: (payload as any).banReason || 'Account suspended',
      });
    }

    // Role and permission checks only apply when specific permissions are required.
    // requirePermissions({}) means "verify JWT only" — no role needed (e.g. anonymous users).
    const hasPermissions = Object.keys(required).length > 0;

    if (hasPermissions) {
      if (!payload.role) {
        return res.status(403).json({ error: 'Forbidden: Missing role in token.' });
      }

      const normalizedRole = normalizeRole(payload.role as string);
      if (!normalizedRole) {
        return res.status(403).json({ error: 'Forbidden: Invalid role.' });
      }

      // Update req.auth with normalized role so downstream sees a valid WXYCRole
      req.auth = { ...req.auth!, role: normalizedRole };

      const roleImpl = WXYCRoles[normalizedRole];

      const ok = Object.entries(required).every(([resource, actions]) => {
        if (!actions || actions.length === 0) return true;

        const authorize = roleImpl.authorize as (request: RequiredPermissions) => { success: boolean };

        const result = authorize({
          [resource]: actions,
        } as RequiredPermissions);

        return result.success;
      });

      if (!ok) {
        return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      }
    }

    return next();
  };
}
