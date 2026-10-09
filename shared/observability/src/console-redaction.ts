import { redactLogValue } from './redact-query-params.js';

const INSTALLED = Symbol.for('wxyc.console-redaction.installed');
type Writer = (...args: unknown[]) => void;
type Target = { error: Writer; warn: Writer };

/**
 * Passes every argument of `console.error` and `console.warn` through
 * `redactLogValue`, so a failed query's bound values (legal names since
 * BS#3051) cannot reach the container log through a library that logs the raw
 * error itself (BS#3054). It exists for better-auth's nested better-call router,
 * which runs `console.error('# SERVER_ERROR: ', error)` on any non-APIError
 * outside better-auth's `logger.log`, and for the adapter's fallback-join
 * `console.error(error)`; the only router setting that stops the former
 * (`onAPIError: { throw: true }`) also changes the HTTP response a client gets.
 *
 * Call it once, before the first request, in a process that serves better-auth.
 * It wraps whatever is installed at that moment, so Sentry's console breadcrumbs
 * (patched earlier, at `Sentry.init`) receive the redacted arguments too.
 * Idempotent. Returns a function that restores the previous writers.
 */
export function installConsoleRedaction(target: Target = console): () => void {
  const marked = target as Target & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return () => {};

  const { error, warn } = target;
  const wrap =
    (write: Writer): Writer =>
    (...args) =>
      write(...args.map((arg) => redactLogValue(arg)));
  target.error = wrap(error);
  target.warn = wrap(warn);
  marked[INSTALLED] = true;

  return () => {
    target.error = error;
    target.warn = warn;
    delete marked[INSTALLED];
  };
}
