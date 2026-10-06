/**
 * The structural slice of an Express error middleware this module needs.
 * Spelled out locally so the package does not take a dependency on `express`.
 */
type ErrorMiddleware = (error: unknown, req: unknown, res: unknown, next: (error?: unknown) => void) => void;

/** The mechanism Sentry 10's `setupExpressErrorHandler` stamped on its captures. */
const MECHANISM = { type: 'auto.middleware.express', handled: false } as const;

export interface SentryExpressErrorCaptureOptions {
  /** Decides whether an error is captured. Receives the RAW pipeline value. */
  shouldCapture: (error: unknown) => boolean;
  /**
   * The app's own `Sentry.captureException` from `@sentry/node`. Injected rather
   * than imported so the capture goes to the SDK copy `Sentry.init` configured:
   * Sentry keys its global state by SDK version, so an `@sentry/core` resolved
   * here could diverge from `@sentry/node`'s pinned copy after a dependency
   * bump and capture into a client-less hub, silently. It also keeps this
   * barrel, which every preload loads, free of runtime imports.
   */
  captureException: (error: unknown, hint: { mechanism: typeof MECHANISM }) => unknown;
}

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
 * included, exactly as Sentry 10's `shouldHandleError` did. A predicate that
 * throws counts as "capture" — failing toward visibility — and the ORIGINAL
 * error is always forwarded with `next(error)`, so the response is unaffected.
 * The mechanism matches the one Sentry 10 stamped, keeping issue grouping and
 * the `handled: false` flag unchanged.
 */
export function sentryExpressErrorCapture({
  shouldCapture,
  captureException,
}: SentryExpressErrorCaptureOptions): ErrorMiddleware {
  return function sentryExpressErrorCaptureMiddleware(error, _req, _res, next) {
    let capture = true;
    try {
      capture = shouldCapture(error);
    } catch {
      // Fall through with capture = true: a broken predicate must not hide the error.
    }
    if (capture) {
      captureException(error, { mechanism: MECHANISM });
    }
    next(error);
  };
}
