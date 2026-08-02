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
  // Deliberately unconditional (BS#1221) — this intentionally overrides
  // `shouldCaptureAuthExpressError` (`./sentry-error-filter.ts`, BS#1387),
  // which only governs `Sentry.setupExpressErrorHandler`'s own capture.
  // An error reaching this generic Express fallback is itself unexpected
  // (every status-carrying error path is handled upstream), so it's worth
  // capturing here regardless of what the predicate would have decided.
  // Sentry dedupes by event hash server-side, so a case where the
  // integration also captured the same error does not double-count as a
  // distinct issue. This call is also load-bearing for
  // `tests/unit/auth/fallback-error-handler.test.ts` — do not remove it as
  // a "redundant Sentry call" cleanup without re-reading BS#1221.
  Sentry.captureException(err);

  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}
