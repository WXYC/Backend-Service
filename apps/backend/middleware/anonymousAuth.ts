import { Request, Response, NextFunction, RequestHandler } from 'express';
import { auth } from '@wxyc/authentication';
import { fromNodeHeaders } from 'better-auth/node';
import { recordActivity } from '../services/activityTracking.service.js';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        isAnonymous?: boolean;
        banned?: boolean;
        banReason?: string | null;
        banExpires?: Date | null;
        [key: string]: unknown;
      };
    }
  }
}

/**
 * Middleware that requires authentication via better-auth session.
 * Extracts Bearer token from Authorization header, validates the session,
 * and attaches the user info to the request.
 *
 * Also checks if the user is banned and records activity.
 */
export const requireAnonymousAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
      res.status(401).json({ message: 'Authentication required' });
      return;
    }

    // Check if user is banned (better-auth admin plugin adds these fields)
    const userWithBan = session.user as typeof session.user & { banned?: boolean; banReason?: string | null };
    if (userWithBan.banned) {
      res.status(403).json({
        message: 'Access denied',
        reason: userWithBan.banReason || 'Account suspended',
      });
      return;
    }

    // Attach user to request
    req.user = session.user as Express.Request['user'];

    // Record activity (fire and forget)
    recordActivity(session.user.id).catch((error) => {
      console.error('Failed to record activity:', error);
    });

    next();
  } catch (error) {
    console.error('Auth validation error:', error);
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};
