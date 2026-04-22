import { RequestHandler } from 'express';
import * as Sentry from '@sentry/node';
import { recordActivity } from '../services/activityTracking.service.js';

/**
 * Middleware that records user activity (fire-and-forget).
 * Must run after requirePermissions so that req.auth is set.
 */
export const trackActivity: RequestHandler = (req, res, next) => {
  if (req.auth?.id) {
    recordActivity(req.auth.id).catch((error) => {
      console.error('Failed to record activity:', error);
      Sentry.captureException(error, {
        tags: { subsystem: 'activity-tracking' },
        extra: { userId: req.auth?.id },
      });
    });
  }
  next();
};
