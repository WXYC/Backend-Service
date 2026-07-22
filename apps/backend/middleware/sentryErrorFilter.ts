import { LmlClientError } from '@wxyc/lml-client';
import WxycError from '../utils/error.js';
import { carriedClientStatus } from './errorHandler.js';

/**
 * Decides whether `Sentry.setupExpressErrorHandler` should auto-capture an
 * error that bubbled to express's error pipeline. Returning false skips the
 * capture; the error still propagates to the application's `errorHandler` and
 * the structured response is unaffected.
 *
 * `LmlClientError` is excluded because it is an expected external-dependency
 * signal: the LML client throws it on timeout, non-2xx, or transport failure;
 * `errorHandler` already translates it into a 502/503/504 response; and the
 * code paths where LML observability is load-bearing (metadata enrichment,
 * linkage backfill) capture to Sentry explicitly. Letting the express handler
 * also capture it produces duplicate noise that drowns out genuine bugs —
 * see BACKEND-SERVICE-5 (309 events in 75 minutes during the 2026-04-30
 * cascade from the catalog-search 503 incident).
 */
export function shouldCaptureExpressError(error: Error): boolean {
  // Sentry passes the RAW pipeline value; errorHandler wraps non-Error
  // throwables in `new Error(String(err))` — dropping any carried status —
  // so they always render as generic 500s. Normalize identically: a
  // next()'d plain object with a trusted-looking 4xx must still be
  // captured, or its 500 response would be invisible to monitoring.
  if (!(error instanceof Error)) return true;
  if (error instanceof LmlClientError) return false;
  // Application errors keep their own rule: errorHandler echoes a WxycError
  // at any status, and only the 5xx band is Sentry-worthy.
  if (error instanceof WxycError) return error.statusCode >= 500;
  // Foreign errors: suppress exactly the trusted 4xx band that errorHandler
  // echoes as a client error — via the SAME `carriedClientStatus` helper
  // (integer 4xx + `expose: true` or the router's percent-decode URIError,
  // which is unauthenticated-reachable via the public GET /concerts/:id —
  // BS#1694 — and must not spam Sentry). Everything else renders as a
  // generic 500 and MUST be captured — including upstream-SDK errors
  // (groq-sdk) whose 4xx `.status` mirrors the provider: a rotated API key
  // or provider rate-limiting is a dependency failure, not client noise.
  return carriedClientStatus(error) === null;
}
