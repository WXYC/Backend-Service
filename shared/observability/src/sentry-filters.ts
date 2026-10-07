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
 *     `/auth/ok`; `apps/backend`'s runs a DB probe). It produced no
 *     transaction at all under Sentry 10 — hence the zero above. Under Sentry
 *     11 (`traceLifecycle: 'static'`) it does produce a `GET /healthcheck`
 *     transaction, and this entry is what drops it (verified 2026-10-06 against
 *     11.4.0, BS#2948). Do not remove it as dead weight.
 *
 * Dropping these transactions has no effect on error reporting: `wxyc-canary`
 * alerts on `/healthcheck` failures via `beforeSend` and the Express error
 * capture configured by `expressIntegration({ shouldHandleError })` in each
 * app's `instrument.ts`, which is a separate pipeline from
 * `beforeSendTransaction`.
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
 * Express's auto-instrumentation spans — framework bookkeeping that records
 * which of Express's own frames ran, not what the request did. Named below by
 * their Sentry 11 ops (`middleware` / `router` / `handler`); Sentry 10 called
 * the same three `middleware.express` / `router.express` /
 * `request_handler.express`.
 *
 * **`middleware`** (`corsMiddleware`, `jsonParser`, route-local handlers) was
 * the original BS#2089 target: each span records only "this middleware ran."
 *
 * **`router` and `handler` were deliberately EXCLUDED by BS#2089**, on the
 * reasoning that route resolution and the handler frame "carry the information
 * you actually want when tracing a slow request." BS#2406 reversed that. The
 * reversal is recorded here rather than silently applied, because the original
 * call was considered, not an oversight:
 *
 * - Cost: 299,867 spans / 7d measured 2026-09-09 (`router.express` 150,118 +
 *   `request_handler.express` 149,749) — 7.5% of the entire WXYC Sentry org's
 *   span budget, while the org was running at 337% of its reserved 5M/month.
 * - What survives on every transaction: the `http.server` span (total
 *   duration, status, route name), every `db` span, every `http.client` span,
 *   and every custom app span (`lml.lookup`, `catalog.cascade`, …). Those are
 *   what actually diagnose a slow request.
 * - What is lost: handler time as a directly-read number. It becomes an
 *   inference — transaction duration minus the surviving children. That is a
 *   real degradation, accepted knowingly.
 *
 * If this is ever revisited, restore `handler` first; `router` is Express
 * choosing which function to call.
 *
 * **Matched by origin and op since Sentry 11 (BS#2948).** Sentry 11 replaced
 * the OTel-based Express instrumentation with `@sentry/server-utils`'
 * diagnostics-channel one, which stamps origin `auto.http.express` and the
 * generic `@sentry/conventions` ops. The old `*.express` match kept every
 * Express span after the upgrade with no test failing. The new ops are generic
 * enough that another framework integration could emit them, so they match
 * only alongside Express's own origin. The filter only runs at all because
 * both preloads pin `traceLifecycle: 'static'` — Sentry 11's default span
 * streaming never builds a transaction event.
 */
const EXPRESS_INSTRUMENTATION_SPAN_OPS = new Set(['middleware', 'router', 'handler']);
const EXPRESS_INSTRUMENTATION_ORIGIN = 'auto.http.express';

export function isExpressInstrumentationSpan(span: Pick<SpanJSON, 'op' | 'origin'>): boolean {
  return (
    span.origin === EXPRESS_INSTRUMENTATION_ORIGIN &&
    span.op !== undefined &&
    EXPRESS_INSTRUMENTATION_SPAN_OPS.has(span.op)
  );
}

/**
 * `beforeSendTransaction` for both `apps/backend/instrument.ts` and
 * `apps/auth/instrument.ts` (BS#2089, widened by BS#2406). Returning `null`
 * drops the whole transaction event. Express instrumentation spans are
 * stripped from `event.spans` on every surviving transaction.
 *
 * **Only runs under `traceLifecycle: 'static'`.** In Sentry 11.4.0,
 * `beforeSendTransaction` is `@deprecated`: span streaming (the default) ignores
 * it, and it "will be removed in v12". The SDK's replacement for dropping spans
 * under either lifecycle is `ignoreSpans` (the old reason for filtering here —
 * that `beforeSendSpan` can modify but not drop a span — predates it). Moving
 * this filter there, or not creating Express spans at all via
 * `expressIntegration({ ignoreLayersType })`, is BS#2959, and is required
 * before the v12 upgrade.
 *
 * **`null` is reserved for liveness paths.** A transaction whose spans are
 * *entirely* filtered still ships, as a transaction with an empty span list —
 * its duration, status and route name are exactly the signal the surviving
 * event exists to carry, and dropping it would silently delete real traffic
 * from the performance product.
 */
export function filterSentryTransactionEvent(event: TransactionEvent): TransactionEvent | null {
  if (isLivenessRequestPath(event.request?.url)) return null;

  if (!event.spans || event.spans.length === 0) return event;

  const spans = event.spans.filter((span) => !isExpressInstrumentationSpan(span));
  if (spans.length === event.spans.length) return event;

  return { ...event, spans };
}
