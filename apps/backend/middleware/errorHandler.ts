import WxycError from '../utils/error.js';
import { LmlClientError } from '@wxyc/lml-client';
import { Request, Response, NextFunction } from 'express';

function hasStatusCode(error: Error): error is WxycError | LmlClientError {
  return error instanceof WxycError || error instanceof LmlClientError;
}

/**
 * TRUSTED 4xx status carried by errors thrown from Express internals and
 * standard middleware: the router's percent-decode failure is a `URIError`
 * with `status: 400` (and no `statusCode`), while http-errors-style
 * throwers (body-parser) set both aliases, sometimes string-encoded, plus
 * `expose: true` for the 4xx band. Without this mapping, a malformed escape
 * in a path segment (`GET /concerts/%ZZ`, unauthenticated-reachable since
 * the BS#1694 public by-id route) surfaced as a probe-mintable 500.
 *
 * A 4xx number alone is NOT proof the error is client-caused or its message
 * client-safe: upstream SDK errors (groq-sdk `APIError` et al.) mirror the
 * provider's HTTP status onto `.status` and embed the raw provider body in
 * `message` — echoing those would leak provider/org/quota internals to
 * unauthenticated-tier callers and misreport our own dependency failures as
 * the caller's 4xx. So echo requires the integer 4xx band (Express 5's
 * `res.status()` throws on non-integers) AND a trust signal: `expose: true`
 * (the http-errors convention — set exactly when the thrower deems the
 * message response-safe) or the router's own percent-decode `URIError`
 * (message derived from the request path). Everything else — foreign 5xx,
 * no status, untrusted 4xx — stays on the generic-500 path so internals
 * never leak.
 *
 * SHARED CLASSIFIER — `shouldCaptureExpressError` (sentryErrorFilter.ts)
 * imports this so the response tier and the Sentry-capture tier resolve the
 * aliases and the trust gate identically: whatever answers as an echoed 4xx
 * is capture-suppressed, and whatever answers as a generic 500 is captured.
 * Diverging reads would let a 500-answered failure hide from monitoring.
 */
export function carriedClientStatus(error: Error): number | null {
  const raw = (error as { status?: number | string }).status ?? (error as { statusCode?: number | string }).statusCode;
  const numeric = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 400 || numeric >= 500) {
    return null;
  }
  if ((error as { expose?: boolean }).expose === true) {
    return numeric;
  }
  if (error instanceof URIError && numeric === 400) {
    return numeric;
  }
  return null;
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
