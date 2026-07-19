import WxycError from '../utils/error.js';
import { LmlClientError } from '@wxyc/lml-client';
import { Request, Response, NextFunction } from 'express';

function hasStatusCode(error: Error): error is WxycError | LmlClientError {
  return error instanceof WxycError || error instanceof LmlClientError;
}

/**
 * 4xx status carried by errors thrown from Express internals and standard
 * middleware: the router's percent-decode failure is a `URIError` with
 * `status: 400` (and no `statusCode`), while http-errors-style throwers
 * (body-parser) set both aliases, sometimes string-encoded. Only the
 * integer 4xx band is trusted — those are by construction client-input
 * errors whose messages are safe to echo (and Express 5's `res.status()`
 * throws on non-integer codes). Foreign errors carrying a 5xx (or no)
 * status stay on the generic-500 path so internals never leak. Without
 * this mapping, a malformed escape in a path segment (`GET /concerts/%ZZ`,
 * unauthenticated-reachable since the BS#1694 public by-id route) surfaced
 * as a probe-mintable 500.
 *
 * SHARED CLASSIFIER — `shouldCaptureExpressError` (sentryErrorFilter.ts)
 * imports this so the response tier and the Sentry-capture tier resolve the
 * `status`/`statusCode` aliases with byte-identical precedence: whatever
 * answers as an echoed 4xx is capture-suppressed, and whatever answers as a
 * generic 500 is captured. Diverging reads would let a 500-answered failure
 * hide from monitoring.
 */
export function carriedClientStatus(error: Error): number | null {
  const raw = (error as { status?: number | string }).status ?? (error as { statusCode?: number | string }).statusCode;
  const numeric = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 400 && numeric < 500 ? numeric : null;
}

function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // prettier-ignore
  const error = err instanceof Error
    ? err
    : new Error(String(err));

  if (hasStatusCode(error)) {
    console.error(`[${req.method} ${req.url}] ${error.name} ${error.statusCode}: ${error.message}`);
    res.status(error.statusCode).json({ message: error.message });
    return;
  }

  const clientStatus = carriedClientStatus(error);
  if (clientStatus !== null) {
    console.error(`[${req.method} ${req.url}] ${error.name} ${clientStatus}: ${error.message}`);
    res.status(clientStatus).json({ message: error.message });
  } else {
    console.error(`[${req.method} ${req.url}] Unhandled error:`, error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

export default errorHandler;
