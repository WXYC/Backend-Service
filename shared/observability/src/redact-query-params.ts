import type { ErrorEvent } from '@sentry/core';

/**
 * drizzle-orm's `DrizzleQueryError` builds its message as
 * `Failed query: <sql>\nparams: <params>`, so every bound value rides along in
 * the message and the stack's first line, and again as the error's own
 * `params` property. Since BS#3051 those values include a staff member's legal
 * name, which must never reach Sentry or the logs (BS#3054). The SQL text holds
 * no values (Drizzle binds all of them) and stays.
 *
 * The params run to the end of a message, or to the first stack frame in a stack.
 */
const PARAMS_PART = /\nparams: [\s\S]*?(?=\n {4}at |$)/;
const REDACTED_PARAMS = '\nparams: [redacted]';
const MAX_CAUSE_DEPTH = 8;

/** `text` with the bound-parameter part of a failed-query message replaced. */
const scrubParams = (text: string) => text.replace(PARAMS_PART, REDACTED_PARAMS);

/**
 * A copy of `error` that is safe to log or report: no bound parameter survives
 * in the message, stack, `params` property or any `cause`. Duck-typed on the
 * message rather than `instanceof DrizzleQueryError` because `instrument.js` is
 * bundled separately from the app. An error with nothing to redact, and any
 * non-`Error` value, comes back as the same object.
 */
export function redactQueryParams<T>(error: T, depth = 0): T {
  if (!(error instanceof Error) || depth > MAX_CAUSE_DEPTH) return error;
  const cause = redactQueryParams(error.cause, depth + 1);
  const message = scrubParams(error.message);
  if (message === error.message && cause === error.cause) return error;

  const clean = new Error(message, cause === undefined ? undefined : { cause });
  clean.name = error.name;
  if (error.stack !== undefined) clean.stack = scrubParams(error.stack);
  return clean as T;
}

/**
 * `beforeSend` for the Express servers: rewrites each exception value in the
 * event (the error and its `linkedErrors` causes) and the breadcrumbs, which
 * quote anything a handler passed to `console.error`.
 */
export function redactSentryEventQueryParams(event: ErrorEvent): ErrorEvent {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) exception.value = scrubParams(exception.value);
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message !== undefined) breadcrumb.message = scrubParams(breadcrumb.message);
  }
  return event;
}
