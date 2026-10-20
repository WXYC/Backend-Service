import type { ErrorReporter, ReportBreadcrumb, ReportContext } from './error-reporter.js';

/** Discards every report. The default, so a library used before any app wiring never throws. */
const noopReporter: ErrorReporter = {
  captureException(_err: unknown, _context?: ReportContext): void {},
  captureMessage(_message: string, _context?: ReportContext): void {},
  addBreadcrumb(_crumb: ReportBreadcrumb): void {},
  setRequestTag(_key: string, _value: string): void {},
  flush(_timeoutMs?: number): Promise<boolean> {
    return Promise.resolve(true);
  },
};

/**
 * The holder lives on `globalThis` under a registered symbol, not in a module-local `let`. A process
 * can load this module more than once: a library built as both ESM and CJS (`@wxyc/authentication`)
 * may resolve the CJS build while its app registers through the ESM one. A module-local holder would
 * give each copy its own slot, and the library would see the no-op default and drop every capture.
 * `Symbol.for` returns the same symbol in every copy and module format, so they all share one slot.
 */
const SLOT = Symbol.for('@wxyc/observability/error-reporter');
type GlobalWithReporter = typeof globalThis & { [SLOT]?: ErrorReporter };

/** Registers the process-wide reporter, replacing any earlier one. An app does this once at startup, next to its SDK init. */
export function setErrorReporter(reporter: ErrorReporter): void {
  (globalThis as GlobalWithReporter)[SLOT] = reporter;
}

/** The process-wide reporter; a no-op until `setErrorReporter` is called. Call sites resolve it per call, never at import time. */
export function getErrorReporter(): ErrorReporter {
  return (globalThis as GlobalWithReporter)[SLOT] ?? noopReporter;
}

/**
 * Reporter for errors that reach the Express error pipeline, kept apart from the process-wide reporter. Sentry's
 * `expressIntegration` already captures those (with its own predicate), so sending them through the process-wide
 * composite would count each error twice in Sentry. It is the vendor reporter that has no Express integration of
 * its own, and goes away with the Sentry exit (BS#3393). Same `globalThis` slot reasoning as above.
 */
const EXPRESS_SLOT = Symbol.for('@wxyc/observability/express-error-reporter');
type GlobalWithExpressReporter = typeof globalThis & { [EXPRESS_SLOT]?: ErrorReporter };

export function setExpressErrorReporter(reporter: ErrorReporter): void {
  (globalThis as GlobalWithExpressReporter)[EXPRESS_SLOT] = reporter;
}

/** The Express-pipeline reporter; a no-op until `setExpressErrorReporter` is called. */
export function getExpressErrorReporter(): ErrorReporter {
  return (globalThis as GlobalWithExpressReporter)[EXPRESS_SLOT] ?? noopReporter;
}
