import { LmlClientError } from '@wxyc/lml-client';
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
  if (error instanceof LmlClientError) return false;
  // Suppress exactly the integer-4xx band that errorHandler echoes as a
  // client error — via the SAME `carriedClientStatus` helper, so the two
  // tiers can never classify one error divergently. This covers WxycError's
  // `statusCode`, http-errors' dual aliases, and Express's own `status`
  // (router percent-decode URIErrors carry ONLY `status: 400`, and are
  // unauthenticated-reachable via the public GET /concerts/:id — BS#1694 —
  // so missing the alias would spam Sentry with client-input noise).
  // Everything else renders as a generic 500 and MUST be captured.
  return carriedClientStatus(error) === null;
}
