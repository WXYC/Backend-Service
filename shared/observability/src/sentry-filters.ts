import type { SpanJSON, TransactionEvent } from '@sentry/core';

/**
 * Transaction names that are pure liveness probes with no diagnostic value
 * in Sentry's performance product (BS#2089). Both are plain `GET` routes, so
 * Sentry's Express auto-instrumentation names their transaction after the
 * route path with no parameterization:
 *   - `GET /ok` — better-auth's built-in liveness endpoint, mounted under
 *     `/auth` in `apps/auth/instrument.ts`. Hit directly by infra health
 *     checks; ~40k requests / 14d, ~7 spans each, purely plugin-hook
 *     bookkeeping.
 *   - `GET /healthcheck` — the app-level liveness route in both
 *     `apps/backend/app.ts` and `apps/auth/app.ts`. `apps/auth`'s handler
 *     proxies to `/auth/ok`; `apps/backend`'s runs a DB probe. Neither's
 *     *transaction* carries anything an operator would trace into — the
 *     probe result is already in the response body and, on failure, in a
 *     captured *error* event, which this filter does not touch.
 *
 * Dropping these transactions has no effect on error reporting: `wxyc-canary`
 * alerts on `/healthcheck` failures via `beforeSend`/`setupExpressErrorHandler`
 * capture, which is a separate pipeline from `beforeSendTransaction`.
 */
const LIVENESS_TRANSACTION_NAMES = new Set(['GET /ok', 'GET /healthcheck']);

export function isLivenessTransaction(transactionName: string | undefined): boolean {
  return transactionName !== undefined && LIVENESS_TRANSACTION_NAMES.has(transactionName);
}

/**
 * Express's per-middleware auto-instrumentation span op (`corsMiddleware`,
 * `jsonParser`, route-local handlers, etc.) — each records only "this
 * middleware ran," not a route or timing signal an operator would read.
 * Deliberately narrower than `router.express` (route resolution) and
 * `request_handler.express` (the route handler itself), which carry the
 * information you actually want when tracing a slow request and must pass
 * through untouched.
 */
const EXPRESS_MIDDLEWARE_SPAN_OP = 'middleware.express';

export function isExpressMiddlewareSpan(span: Pick<SpanJSON, 'op'>): boolean {
  return span.op === EXPRESS_MIDDLEWARE_SPAN_OP;
}

/**
 * `beforeSendTransaction` for both `apps/backend/instrument.ts` and
 * `apps/auth/instrument.ts` (BS#2089). Returning `null` drops the whole
 * transaction event, so liveness routes are filtered here rather than via
 * `beforeSendSpan` — the SDK's `beforeSendSpan` type can only modify a span,
 * not drop it. Express middleware bookkeeping spans are stripped from
 * `event.spans` on every surviving transaction.
 */
export function filterSentryTransactionEvent(event: TransactionEvent): TransactionEvent | null {
  if (isLivenessTransaction(event.transaction)) return null;

  if (!event.spans || event.spans.length === 0) return event;

  const spans = event.spans.filter((span) => !isExpressMiddlewareSpan(span));
  if (spans.length === event.spans.length) return event;

  return { ...event, spans };
}
