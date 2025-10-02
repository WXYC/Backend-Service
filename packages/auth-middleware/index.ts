import { Request, Response, NextFunction } from 'express';
import { betterAuth } from 'better-auth';
import { AppError, UnauthorizedError, ForbiddenError } from '@wxyc/shared';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8787';

// Better Auth client for JWT verification
const authClient = betterAuth({
  baseURL: AUTH_SERVICE_URL,
});

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    realName?: string;
    djName?: string;
    onboarded: boolean;
    appSkin: string;
    role?: string;
  };
}

export const authMiddleware = (required: boolean = true) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      // Check for AUTH_BYPASS mode (for testing)
      if (process.env.AUTH_BYPASS === 'true') {
        // Mock user data for testing - matches seeded data
        req.user = {
          id: 'test-user-id',
          email: process.env.AUTH_USERNAME || 'test@example.com',
          realName: 'Test User',
          djName: 'Test DJ',
          onboarded: true,
          appSkin: 'modern-light',
          role: process.env.AUTH_TEST_ROLE || 'dj'
        };
        return next();
      }

      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        if (required) {
          throw new UnauthorizedError('Authorization header required');
        }
        return next();
      }

      const token = authHeader.startsWith('Bearer ') 
        ? authHeader.slice(7) 
        : authHeader;

      // Verify JWT token with auth service
      const session = await authClient.api.getSession({
        headers: {
          authorization: `Bearer ${token}`
        } as any
      });

      if (!session) {
        throw new UnauthorizedError('Invalid or expired token');
      }

      // Attach user info to request with proper type mapping
      req.user = {
        id: session.user.id,
        email: session.user.email,
        realName: (session.user as any).realName || undefined,
        djName: (session.user as any).djName || undefined,
        onboarded: (session.user as any).onboarded || false,
        appSkin: (session.user as any).appSkin || 'modern-light',
        role: (session.user as any).role || undefined
      };
      next();
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message
        });
      }
      
      console.error('Auth middleware error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authentication service error'
      });
    }
  };
};

// Define role hierarchy - higher roles inherit permissions from lower roles
const ROLE_HIERARCHY = {
  'guest': 0,
  'dj': 1,
  'music-director': 2,
  'station-management': 3
} as const;

type Role = keyof typeof ROLE_HIERARCHY;

// Get user's effective role based on their stored role and onboarded status
const getUserRole = (user: AuthenticatedRequest['user']): Role => {
  if (!user) return 'guest';
  
  // If user has an explicit role, use it
  if (user.role && user.role in ROLE_HIERARCHY) {
    return user.role as Role;
  }
  
  // Fallback to legacy logic: onboarded users are DJs, others are guests
  return user.onboarded ? 'dj' : 'guest';
};

// Check if user has required role or higher
const hasRole = (userRole: Role, requiredRoles: Role[]): boolean => {
  const userLevel = ROLE_HIERARCHY[userRole];
  return requiredRoles.some(role => userLevel >= ROLE_HIERARCHY[role]);
};

// Role-based middleware
export const requireRole = (roles: Role[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const userRole = getUserRole(req.user);
    
    if (!hasRole(userRole, roles)) {
      throw new ForbiddenError('Insufficient permissions');
    }

    next();
  };
};

// DJ-specific middleware (legacy - now uses role system)
export const requireDJ = requireRole(['dj']);

// Convenience middleware for specific roles
export const requireMusicDirector = requireRole(['music-director']);
export const requireStationManagement = requireRole(['station-management']);

// Export role type for use in other modules
export type { Role };
export { getUserRole, hasRole, ROLE_HIERARCHY };

export default {
  authMiddleware,
  requireRole,
  requireDJ,
  requireMusicDirector,
  requireStationManagement
};
