import { captureException } from '@sentry/core';

/**
 * The structural slice of an Express error middleware this module needs.
 * Spelled out locally so the package does not take a dependency on `express`.
 */
type ErrorMiddleware = (error: unknown, req: unknown, res: unknown, next: (error?: unknown) => void) => void;

/**
 * Terminal Express error middleware that captures to Sentry iff `shouldCapture`
 * accepts the error (BS#2947). Mount it after every route and immediately
 * before the app's own terminal error handler, in place of Sentry 10's
 * `setupExpressErrorHandler(app, { shouldHandleError })`.
 *
 * Why this exists rather than Sentry 11's own API: Sentry 11 moved
 * `shouldHandleError` onto the default `expressIntegration`, which captures at
 * the layer that THREW — before any application error middleware runs. That
 * would capture errors an intermediate handler deliberately swallows, which
 * Sentry 10's terminal handler never saw. Both preloads therefore pass
 * `expressIntegration({ shouldHandleError: false })`, and this middleware
 * restores the Sentry 10 capture point. The predicate stays in `app.ts`
 * rather than the preload because the preload's static imports evaluate
 * before `Sentry.init` registers its diagnostics-channel injection.
 *
 * `shouldCapture` receives the RAW pipeline value, non-`Error` throwables
 * included, exactly as Sentry 10's `shouldHandleError` did. The error is
 * always forwarded with `next(error)`, so the response is unaffected. The
 * mechanism matches the one Sentry 10 stamped, keeping issue grouping
 * and the `handled: false` flag unchanged.
 */
export function sentryExpressErrorCapture<E>(shouldCapture: (error: E) => boolean): ErrorMiddleware {
  return function sentryExpressErrorCaptureMiddleware(error, _req, _res, next) {
    // The cast mirrors Sentry 10's contract: the predicate is typed for the
    // errors it expects but is handed whatever the pipeline carries.
    if (shouldCapture(error as E)) {
      captureException(error, { mechanism: { type: 'auto.middleware.express', handled: false } });
    }
    next(error);
  };
}
