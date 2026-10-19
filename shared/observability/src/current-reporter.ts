import type { CounterFields, ErrorReporter, ReportBreadcrumb, ReportContext } from './error-reporter.js';

/** Discards every report. The default, so a library used before any app wiring never throws. */
const noopReporter: ErrorReporter = {
  captureException(_err: unknown, _context?: ReportContext): void {},
  captureMessage(_message: string, _context?: ReportContext): void {},
  addBreadcrumb(_crumb: ReportBreadcrumb): void {},
  setRequestTag(_key: string, _value: string): void {},
  recordCounter(_name: string, _value: number, _fields?: CounterFields): void {},
  flush(_timeoutMs?: number): Promise<boolean> {
    return Promise.resolve(true);
  },
};

let current: ErrorReporter = noopReporter;

/** Registers the process-wide reporter, replacing any earlier one. An app does this once at startup, next to its SDK init. */
export function setErrorReporter(reporter: ErrorReporter): void {
  current = reporter;
}

/** The process-wide reporter; a no-op until `setErrorReporter` is called. Call sites resolve it per call, never at import time. */
export function getErrorReporter(): ErrorReporter {
  return current;
}
