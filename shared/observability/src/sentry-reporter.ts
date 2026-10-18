import * as Sentry from '@sentry/node';
import { logCounter } from './error-reporter.js';
import type { CounterFields, ErrorReporter, ReportBreadcrumb, ReportContext } from './error-reporter.js';

/**
 * `ErrorReporter` over `@sentry/node`, making the same calls the call sites make
 * today: levels, tags, extra, fingerprints and breadcrumbs pass straight through.
 * `recordCounter` writes the structured log line rather than `Sentry.metrics.count`
 * (BS#3393 PD2: nothing pages on these counters).
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

  recordCounter(name: string, value: number, fields?: CounterFields): void {
    logCounter(name, value, fields);
  }

  flush(timeoutMs?: number): Promise<boolean> {
    return Sentry.flush(timeoutMs);
  }
}
