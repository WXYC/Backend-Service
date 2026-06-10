/**
 * Decides whether `Sentry.setupExpressErrorHandler` should auto-capture an
 * error that bubbled to the auth service's express error pipeline. Returning
 * false skips the Sentry capture; the error still propagates to
 * `fallbackErrorHandler`, which always emits a sanitised 500 response.
 *
 * Why this exists (BS#1387):
 *
 * Without an explicit predicate, the SDK's `defaultShouldHandleError` ignores
 * 4xx errors only when the error carries an explicit `status` / `statusCode`
 * property below 500. Any thrown `ProvisionError(400/404/409)` does carry a
 * `statusCode` and is correctly skipped — but bare Errors and `Error`s tagged
 * by upstream middleware with non-numeric status values fall through the
 * default's `parseInt(... ?? 500)` and get captured as 500s. That's noisy
 * (the failure mode is "auth threw an unexpected exception" — that *should*
 * page) but it's also indistinguishable from genuine 5xx errors. Naming the
 * predicate makes the policy explicit, mirrors `apps/backend/middleware/
 * sentryErrorFilter.ts`, and gives a single place to refine if a noisy class
 * of error emerges.
 *
 * Policy: capture iff the error has no resolvable HTTP status, has a NaN
 * status, or has a status of 500 or higher. 4xx errors (validation,
 * not-found, conflict) are expected and handled at the response layer.
 *
 * The auth service has no equivalent of `LmlClientError` to special-case —
 * better-auth's plugin errors propagate as `APIError` instances with `status`
 * codes that the default predicate already filters correctly.
 */
export function shouldCaptureAuthExpressError(error: Error): boolean {
  const raw = (error as { statusCode?: number | string }).statusCode ?? (error as { status?: number | string }).status;
  const numeric = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  return numeric === undefined || Number.isNaN(numeric) || numeric >= 500;
}
