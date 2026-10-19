import { getErrorReporter } from '@wxyc/observability';
import type { Request, Response, NextFunction } from 'express';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = req.get('X-Request-Id') || crypto.randomUUID();

  res.setHeader('X-Request-Id', requestId);
  getErrorReporter().setRequestTag('request_id', requestId);

  next();
}
