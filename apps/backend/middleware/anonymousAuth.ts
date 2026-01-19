import { Request, Response, NextFunction, RequestHandler } from 'express';
import * as AnonymousDeviceService from '../services/anonymousDevice.service.js';
import { AnonymousDevice } from '@wxyc/database';

// Extend Express Request to include device info
declare global {
  namespace Express {
    interface Request {
      anonymousDevice?: AnonymousDevice;
    }
  }
}

/**
 * Middleware that requires anonymous device authentication via JWT.
 * Extracts Bearer token from Authorization header, validates it,
 * and attaches the device info to the request.
 *
 * If the token is valid but nearing expiration, adds refresh headers:
 * - X-Refresh-Token: The new token
 * - X-Token-Expires-At: The new expiration date
 */
export const requireAnonymousAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ message: 'Authorization header required' });
    return;
  }

  // Extract Bearer token
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({ message: 'Invalid authorization format. Expected: Bearer <token>' });
    return;
  }

  const token = parts[1];

  // Validate token and device
  const result = await AnonymousDeviceService.validateTokenAndDevice(token);

  if (!result.valid) {
    switch (result.error) {
      case 'invalid_token':
      case 'expired_token':
        res.status(401).json({ message: 'Invalid or expired token' });
        return;
      case 'blocked':
        res.status(403).json({ message: 'Device has been blocked', reason: result.device?.blockedReason });
        return;
      case 'not_found':
        res.status(401).json({ message: 'Device not found. Please register first.' });
        return;
      default:
        res.status(401).json({ message: 'Authentication failed' });
        return;
    }
  }

  // Attach device to request
  req.anonymousDevice = result.device;

  // Add refresh headers if token needs refresh
  if (result.needsRefresh && result.newToken) {
    res.setHeader('X-Refresh-Token', result.newToken.token);
    res.setHeader('X-Token-Expires-At', result.newToken.expiresAt.toISOString());
  }

  next();
};
