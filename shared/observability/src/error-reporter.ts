/**
 * Vendor-neutral error-reporting seam (BS#3393, slice B1). Call sites depend on
 * `ErrorReporter`; which backend receives the report is decided where the reporter
 * is built. This module imports no vendor SDK, so it is safe in the barrel that
 * every app preloads eagerly. `SentryReporter` lives on the `./sentry` subpath.
 */

/** Severity levels shared by exceptions, messages and breadcrumbs. */
export type ReportLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/** Context attached to a captured exception or message. */
export interface ReportContext {
  level?: ReportLevel;
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  /** Grouping key; replaces the backend's default grouping when set. */
  fingerprint?: string[];
}

/** A breadcrumb: a trail entry attached to later reports. */
export interface ReportBreadcrumb {
  category?: string;
  level?: ReportLevel;
  message?: string;
  data?: Record<string, unknown>;
}

/** Fields of a counter (see `logCounter`; counters are greppable log lines, not paging signals): flat, primitive-valued, so every backend can carry them. */
export type CounterFields = Record<string, string | number | boolean>;

/** What call sites report through. Every method must be safe to call on the error path. */
export interface ErrorReporter {
  captureException(err: unknown, context?: ReportContext): void;
  captureMessage(message: string, context?: ReportContext): void;
  addBreadcrumb(crumb: ReportBreadcrumb): void;
  /**
   * Tags every report made while handling the current request. In Sentry terms this is
   * the current scope, not the isolation scope: run-wide tags such as a job logger's
   * `Sentry.setTag` are a different thing and do not go through this method.
   */
  setRequestTag(key: string, value: string): void;
  /** Resolves once buffered reports are delivered or `timeoutMs` passes; resolves `false` on timeout. */
  flush(timeoutMs?: number): Promise<boolean>;
  /**
   * Optional: runs `fn` with its own request scope, so `setRequestTag` and breadcrumbs made inside it stay
   * with that request (a reporter that keeps them in an AsyncLocalStorage implements it). A reporter whose
   * backend scopes requests itself, as `SentryReporter` does, leaves it out. An HTTP app calls it as
   * `getErrorReporter().runInScope?.(...)` and falls back to calling `fn` directly (see `requestScopeMiddleware`).
   */
  runInScope?<T>(fn: () => T): T;
}

/**
 * Writes the counter as one structured log line, `{"metric": name, "value": …, …fields}`.
 * Never throws: observability must not break the request path. `metric` and `value`
 * win over same-named fields.
 */
export function logCounter(name: string, value: number, fields: CounterFields = {}): void {
  try {
    console.log(JSON.stringify({ ...fields, metric: name, value }));
  } catch {
    // unserialisable input: drop the counter rather than throw
  }
}

/** Fans each call out to the reporters it is given; one reporter throwing does not stop the others. */
export class CompositeReporter implements ErrorReporter {
  constructor(private readonly reporters: readonly ErrorReporter[]) {}

  private each(call: (reporter: ErrorReporter) => void): void {
    for (const reporter of this.reporters) {
      try {
        call(reporter);
      } catch {
        // one failing backend must not hide a report from the rest
      }
    }
  }

  captureException(err: unknown, context?: ReportContext): void {
    this.each((r) => r.captureException(err, context));
  }

  captureMessage(message: string, context?: ReportContext): void {
    this.each((r) => r.captureMessage(message, context));
  }

  addBreadcrumb(crumb: ReportBreadcrumb): void {
    this.each((r) => r.addBreadcrumb(crumb));
  }

  setRequestTag(key: string, value: string): void {
    this.each((r) => r.setRequestTag(key, value));
  }

  /** Nests `fn` inside the scope of each reporter that has `runInScope`, in order; a reporter without it is skipped. */
  runInScope<T>(fn: () => T): T {
    return this.reporters.reduceRight<() => T>((inner, r) => (r.runInScope ? () => r.runInScope!(inner) : inner), fn)();
  }

  /**
   * Flushes every reporter in parallel; resolves `false` if any reporter times out, rejects
   * or throws. There is no deadline of its own: it is bounded only if each reporter honours
   * `timeoutMs`.
   */
  async flush(timeoutMs?: number): Promise<boolean> {
    const results = await Promise.all(
      this.reporters.map((r) =>
        Promise.resolve()
          .then(() => r.flush(timeoutMs))
          .catch(() => false)
      )
    );
    return results.every(Boolean);
  }
}
