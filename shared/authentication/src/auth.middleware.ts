import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AccessControlStatement, WXYCRole, WXYCRoles } from './auth.roles';

// JWT payload structure expected from better-auth JWT plugin
// When used with organization plugin, tokens include user info and organization role
// Standard JWT fields: 'sub' (user ID), 'email'
// Organization plugin adds: organization context with member role
export type WXYCAuthJwtPayload = JWTPayload & {
  id?: string; // User ID (may be in 'sub' field, better-auth may map it)
  sub?: string; // Standard JWT subject (user ID)
  email: string;
  role: WXYCRole; // Organization member role from better-auth organization plugin
};

const issuer = process.env.BETTER_AUTH_ISSUER;
const audience = process.env.BETTER_AUTH_AUDIENCE;
const jwksUrl = process.env.BETTER_AUTH_JWKS_URL;

if (!jwksUrl) {
  throw new Error('BETTER_AUTH_JWKS_URL environment variable is not set.');
}

const JWKS = createRemoteJWKSet(new URL(jwksUrl));

async function verify(token: string) {
  if (!issuer || !audience) {
    throw new Error('JWT verification environment variables are not properly set.');
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
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
    if (process.env.AUTH_BYPASS === 'true') {
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

    // Validate role exists
    if (!payload.role) {
      return res.status(403).json({ error: 'Forbidden: Missing role in token.' });
    }

    const roleImpl = WXYCRoles[payload.role];
    if (!roleImpl) {
      return res.status(403).json({ error: 'Forbidden: Invalid role.' });
    }

    // Check permissions
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

    return next();
  };
}
