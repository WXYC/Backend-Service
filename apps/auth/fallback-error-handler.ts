// Fallback Express error handler for the auth service. Sanitises the response
// body so an unhandled error never leaks SQL fragments, bind values, table or
// column names back to the caller (BS#1109).
//
// The full error is always forwarded to Sentry — only the response body is
// stripped. In non-production environments the detailed message is preserved
// to aid dev debugging, mirroring the pattern in
// `apps/backend/middleware/errorHandler.ts`.
import * as Sentry from '@sentry/node';
import type { Request, Response, NextFunction } from 'express';

export function fallbackErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  Sentry.captureException(err);

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}
