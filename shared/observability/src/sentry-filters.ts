import type { SpanJSON, TransactionEvent } from '@sentry/core';

/**
 * Request paths that are pure liveness probes with no diagnostic value in
 * Sentry's performance product (BS#2089).
 *
 * **Match on the request path, not the transaction name.** The obvious
 * implementation — comparing `event.transaction` against `'GET /ok'` — is a
 * silent no-op in production. Sentry's Express auto-instrumentation names a
 * transaction after the *mount* path, not the path the client requested, and
 * better-auth is mounted as a single handler at `/auth`. Every request under
 * it, `/auth/ok` included, is therefore recorded as `GET /auth`. Verified
 * against 14 days of production data (2026-08-10): `GET /auth` had 72,833
 * transactions while `GET /ok` and `GET /healthcheck` had **zero events
 * org-wide** — no transaction by either name has ever existed.
 *
 * The paths:
 *   - `/auth/ok` — better-auth's built-in liveness endpoint, hit directly by
 *     infra health checks. ~40k requests / 14d at ~7 spans each, all
 *     plugin-hook bookkeeping. This is the volume this filter exists to shed.
 *   - `/healthcheck` — the app-level liveness route in both
 *     `apps/backend/app.ts` and `apps/auth/app.ts` (`apps/auth`'s proxies to
 *     `/auth/ok`; `apps/backend`'s runs a DB probe). It currently produces no
 *     transaction at all — hence the zero above — so listing it sheds nothing
 *     today. It is kept so the probe stays shed if that ever changes; a path
 *     in a Set costs nothing, and re-deriving this the next time span volume
 *     spikes does.
 *
 * Dropping these transactions has no effect on error reporting: `wxyc-canary`
 * alerts on `/healthcheck` failures via `beforeSend`/`setupExpressErrorHandler`
 * capture, which is a separate pipeline from `beforeSendTransaction`.
 */
const LIVENESS_PATHS = new Set(['/auth/ok', '/healthcheck']);

/**
 * `event.request.url` is populated by the SDK's `requestdata` event processor
 * (an absolute URL when the request carried a Host header, a bare path
 * otherwise), and event processors run in `prepareEvent` — before
 * `beforeSendTransaction`. Sentry's server-side scrubbing renders this field
 * as `[Filtered]` in stored data, but that happens after ingestion; the value
 * seen here is the raw one.
 */
export function isLivenessRequestPath(url: string | undefined): boolean {
  if (!url) return false;

  let pathname: string;
  try {
    // The base makes a bare-path URL parse; it is discarded either way.
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return false;
  }

  // `/auth/ok/` is the same probe as `/auth/ok`.
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  return LIVENESS_PATHS.has(normalized);
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
 * transaction event, so liveness probes are filtered here rather than via
 * `beforeSendSpan` — the SDK's `beforeSendSpan` type can only modify a span,
 * not drop it. Express middleware bookkeeping spans are stripped from
 * `event.spans` on every surviving transaction.
 */
export function filterSentryTransactionEvent(event: TransactionEvent): TransactionEvent | null {
  if (isLivenessRequestPath(event.request?.url)) return null;

  if (!event.spans || event.spans.length === 0) return event;

  const spans = event.spans.filter((span) => !isExpressMiddlewareSpan(span));
  if (spans.length === event.spans.length) return event;

  return { ...event, spans };
}
