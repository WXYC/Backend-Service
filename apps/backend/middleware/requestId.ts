import * as Sentry from '@sentry/node';
import type { Request, Response, NextFunction } from 'express';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = req.get('X-Request-Id') || crypto.randomUUID();

  res.setHeader('X-Request-Id', requestId);
  Sentry.getCurrentScope().setTag('request_id', requestId);

  next();
}
