import type { Breadcrumb, ErrorEvent } from '@sentry/core';

/**
 * drizzle-orm's `DrizzleQueryError` builds its message as
 * `Failed query: <sql>\nparams: <params>`, so every bound value rides along in
 * the message and the stack's first line, and again as the error's own
 * `params` property. Since BS#3051 those values include a staff member's legal
 * name, which must never reach Sentry or the logs (BS#3054). The SQL text holds
 * no values (Drizzle binds all of them) and stays.
 *
 * The redaction is structural: the params part is everything from the first
 * marker to the end of the message, so no bound value (a review body with a
 * `\n    at ` line, say) can steer where it stops.
 */
const PARAMS_MARKER = '\nparams: ';
const REDACTED_PARAMS = `${PARAMS_MARKER}[redacted]`;
const FAILING_ROW = /^Failing row contains \(/;
const REDACTED_FAILING_ROW = 'Failing row contains ([redacted])';
const MAX_DEPTH = 8;

/** Own properties of a driver or Drizzle error that hold bound values. */
const PARAM_PROPERTIES = ['params', 'parameters', 'args'] as const;

/** `text` with everything from the params marker to its end replaced. */
function scrubText(text: string): string {
  const at = text.indexOf(PARAMS_MARKER);
  return at === -1 ? text : text.slice(0, at) + REDACTED_PARAMS;
}

/**
 * `stack` with the original `message` swapped for its scrubbed form where the
 * stack embeds it (V8 writes `${name}: ${message}` first), keeping the frames.
 * A stack that does not embed the message is cut at the params marker instead.
 */
function scrubStack(stack: string, message: string, scrubbedMessage: string): string {
  const at = stack.indexOf(message);
  if (at === -1) return scrubText(stack);
  return stack.slice(0, at) + scrubbedMessage + stack.slice(at + message.length);
}

function carriesRow(error: Error): boolean {
  const { detail } = error as { detail?: unknown };
  return typeof detail === 'string' && FAILING_ROW.test(detail);
}

function redactError(error: Error, depth: number): Error {
  const cause = depth < MAX_DEPTH ? redactCause(error.cause, depth + 1) : error.cause;
  const message = scrubText(error.message);
  const hasParamProperty = PARAM_PROPERTIES.some((key) => Object.hasOwn(error, key));
  if (message === error.message && cause === error.cause && !hasParamProperty && !carriesRow(error)) return error;

  // Keep the prototype and every own property (code, status, expose, query, ...)
  // so callers still see the same class; only the value-bearing ones change.
  const clean: Error = Object.create(Object.getPrototypeOf(error));
  Object.defineProperties(clean, Object.getOwnPropertyDescriptors(error));
  const set = (key: string, value: unknown) => {
    const { enumerable = false } = Object.getOwnPropertyDescriptor(error, key) ?? {};
    Object.defineProperty(clean, key, { value, enumerable, writable: true, configurable: true });
  };
  set('message', message);
  if (typeof error.stack === 'string') set('stack', scrubStack(error.stack, error.message, message));
  if (Object.hasOwn(error, 'cause')) set('cause', cause);
  for (const key of PARAM_PROPERTIES) {
    if (Object.hasOwn(error, key)) set(key, '[redacted]');
  }
  if (carriesRow(error)) set('detail', REDACTED_FAILING_ROW);
  return clean;
}

function redactCause(cause: unknown, depth: number): unknown {
  return cause instanceof Error ? redactError(cause, depth) : cause;
}

/**
 * A copy of `error` that is safe to log or report: no bound parameter survives
 * in the message, stack, `params`/`parameters`/`args` properties, a
 * `Failing row contains (...)` constraint detail, or any `cause`. The copy keeps
 * the input's prototype and its other own properties. Duck-typed on the message
 * rather than `instanceof DrizzleQueryError` because `instrument.js` is bundled
 * separately from the app. An error with nothing to redact, and any non-`Error`
 * value, comes back as the same object.
 */
export function redactQueryParams<T>(error: T): T {
  return error instanceof Error ? (redactError(error, 0) as T) : error;
}

/**
 * `value` with failed-query parameters removed, for anything that may be handed
 * to a logger: strings are scrubbed, errors go through `redactQueryParams`, and
 * arrays and plain objects are copied with their members redacted (to a bounded
 * depth). Anything else comes back as is.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value instanceof Error) return redactQueryParams(value);
  if (depth >= 3 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((member) => redactLogValue(member, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, redactLogValue(member, depth + 1)]));
}

/**
 * `beforeSend` for the Express servers: rewrites each exception value in the
 * event (the error and its `linkedErrors` causes). Breadcrumbs are scrubbed
 * earlier, by `redactSentryBreadcrumb`.
 */
export function redactSentryEventQueryParams(event: ErrorEvent): ErrorEvent {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) exception.value = scrubText(exception.value);
  }
  return event;
}

/**
 * `beforeBreadcrumb` for the Express servers. Sentry's console integration
 * records the formatted `message` and also the raw console arguments in
 * `data.arguments`, so a handler that `console.error`s a failed-query error
 * would otherwise ship its message, stack and `params` to Sentry. Running here,
 * before the breadcrumb is stored, it sees the live `Error` objects and covers
 * error and transaction events alike (`beforeSend` never sees the latter's
 * breadcrumbs). The breadcrumb is copied; the logged originals stay untouched.
 */
export function redactSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const clean: Breadcrumb = { ...breadcrumb };
  if (clean.message !== undefined) clean.message = scrubText(clean.message);
  if (clean.data !== undefined) {
    clean.data = Object.fromEntries(Object.entries(clean.data).map(([key, member]) => [key, redactLogValue(member)]));
  }
  return clean;
}
