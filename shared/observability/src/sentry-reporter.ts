import * as Sentry from '@sentry/node';
import type { ErrorReporter, ReportBreadcrumb, ReportContext } from './error-reporter.js';

/**
 * `ErrorReporter` over `@sentry/node`, making the same calls the call sites make
 * today: levels, tags, extra, fingerprints and breadcrumbs pass straight through.
 */
export class SentryReporter implements ErrorReporter {
  captureException(err: unknown, context?: ReportContext): void {
    Sentry.captureException(err, context);
  }

  captureMessage(message: string, context?: ReportContext): void {
    Sentry.captureMessage(message, context);
  }

  addBreadcrumb(crumb: ReportBreadcrumb): void {
    Sentry.addBreadcrumb(crumb);
  }

  setRequestTag(key: string, value: string): void {
    Sentry.getCurrentScope().setTag(key, value);
  }

  flush(timeoutMs?: number): Promise<boolean> {
    return Sentry.flush(timeoutMs);
  }
}
