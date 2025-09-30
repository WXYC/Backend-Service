import { Request, Response, NextFunction } from 'express';
import { betterAuth } from 'better-auth';
import { AppError, UnauthorizedError, ForbiddenError } from '@wxyc/shared';

// This will be configured with the auth service URL
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
          appSkin: 'modern-light'
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
        appSkin: (session.user as any).appSkin || 'modern-light'
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

// Role-based middleware (for future use)
export const requireRole = (roles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // For now, we'll implement basic role checking
    // This can be enhanced based on your role system
    const userRole = req.user.onboarded ? 'dj' : 'guest';
    
    if (!roles.includes(userRole)) {
      throw new ForbiddenError('Insufficient permissions');
    }

    next();
  };
};

// DJ-specific middleware
export const requireDJ = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }

  if (!req.user.onboarded) {
    return res.status(403).json({
      success: false,
      error: 'DJ onboarding required'
    });
  }

  next();
};

export default {
  authMiddleware,
  requireRole,
  requireDJ
};
