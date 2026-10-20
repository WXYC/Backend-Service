import { getErrorReporter, getExpressErrorReporter } from './current-reporter.js';

/**
 * Express middleware for the PostHog path (BS#3393, slice B7). Types are structural so this barrel module
 * imports nothing from `express`.
 */

interface RequestLike {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
}

/** Wraps the rest of the request in the registered reporter's scope, or just continues if it has none. Register it after the body parsers (a parser's stream callbacks run outside the scope) and before the first middleware that tags or breadcrumbs. */
export function requestScopeMiddleware(_req: unknown, _res: unknown, next: () => void): void {
  const reporter = getErrorReporter();
  if (reporter.runInScope) {
    reporter.runInScope(next);
  } else {
    next();
  }
}

export interface ExpressErrorMiddlewareOptions {
  /** The app's existing capture predicate (the one given to Sentry's `expressIntegration`); it receives the raw pipeline value. */
  shouldCapture: (error: Error) => boolean;
  /** The status the app's error handler will answer with. */
  statusOf: (error: unknown) => number;
}

/**
 * Error middleware that reports to the Express-pipeline reporter. It attaches `request_id`, route (the template,
 * not the URL), method and status, and nothing else: no headers, cookies, query string, body or client IP (BS#3004).
 * Register it before the app's own error handler. Never throws and always passes the error on.
 */
export function createExpressErrorMiddleware({ shouldCapture, statusOf }: ExpressErrorMiddlewareOptions) {
  return (
    err: unknown,
    req: RequestLike,
    res: { getHeader(name: string): unknown },
    next: (err?: unknown) => void
  ): void => {
    try {
      if (shouldCapture(err as Error)) {
        const requestId = res.getHeader('X-Request-Id');
        const routePath = typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
        getExpressErrorReporter().captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: {
            ...(typeof requestId === 'string' ? { request_id: requestId } : {}),
            route: routePath,
            method: req.method,
            status: statusOf(err),
          },
        });
      }
    } catch {
      // observability must not break the request path
    }
    next(err);
  };
}
