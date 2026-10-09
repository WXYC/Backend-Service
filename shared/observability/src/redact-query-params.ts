import { types } from 'node:util';
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

/** `instanceof Error` misses errors from another realm (Node core errors under a vm context), so also ask the engine. */
function isError(value: unknown): value is Error {
  return value instanceof Error || types.isNativeError(value);
}

/** What stands in for an error the redaction cannot copy: it must never be the original. */
const UNLOGGABLE_ERROR = '[unloggable error]';
const UNLOGGABLE_VALUE = '[unloggable value]';

/**
 * The copy is built from plain writable data values, never from the input's
 * property descriptors: postgres.js defines `query`, `parameters`, `args` and
 * `types` on its errors as non-writable and non-configurable, and cloning those
 * descriptors makes the redefinition throw on every real failed query.
 */
function redactError(error: Error, depth: number): Error {
  const cause = depth < MAX_DEPTH ? redactCause(error.cause, depth + 1) : error.cause;
  const rawMessage = String(error.message);
  const message = scrubText(rawMessage);
  const hasParamProperty = PARAM_PROPERTIES.some((key) => Object.hasOwn(error, key));
  if (message === rawMessage && cause === error.cause && !hasParamProperty && !carriesRow(error)) return error;

  // Same class, and every own property (code, status, expose, ...) as a plain value;
  // only the value-bearing ones change. A property whose getter throws is left out.
  const clean: Error = Object.create(Object.getPrototypeOf(error));
  const set = (key: string | symbol, value: unknown, enumerable: boolean) =>
    Object.defineProperty(clean, key, { value, enumerable, writable: true, configurable: true });
  for (const key of Reflect.ownKeys(error)) {
    try {
      set(
        key,
        (error as unknown as Record<string | symbol, unknown>)[key],
        Object.prototype.propertyIsEnumerable.call(error, key)
      );
    } catch {
      // unreadable: omit rather than fail
    }
  }
  set('message', message, false);
  if (typeof error.stack === 'string') set('stack', scrubStack(error.stack, rawMessage, message), false);
  if (Object.hasOwn(error, 'cause')) set('cause', cause, false);
  for (const key of PARAM_PROPERTIES) {
    if (Object.hasOwn(error, key)) set(key, '[redacted]', Object.prototype.propertyIsEnumerable.call(error, key));
  }
  const { query } = error as { query?: unknown };
  if (typeof query === 'string')
    set('query', scrubText(query), Object.prototype.propertyIsEnumerable.call(error, 'query'));
  if (carriesRow(error)) set('detail', REDACTED_FAILING_ROW, true);
  return clean;
}

/** The least that is still useful when the full copy cannot be made: class name and redacted message. */
function minimalError(error: unknown): unknown {
  try {
    const { name, message } = error as Error;
    const safe = new Error(scrubText(String(message)));
    safe.name = String(Object.getPrototypeOf(error)?.constructor?.name ?? name);
    return safe;
  } catch {
    return UNLOGGABLE_ERROR;
  }
}

function redactCause(cause: unknown, depth: number): unknown {
  return isError(cause) ? redactError(cause, depth) : cause;
}

/**
 * A copy of `error` that is safe to log or report: no bound parameter survives
 * in the message, stack, `params`/`parameters`/`args` properties, the `query`
 * text's params part, a `Failing row contains (...)` constraint detail, or any
 * `cause`. The copy has the input's prototype and its other own properties as
 * plain values. It is total: it runs on the error path, so anything unexpected
 * (a throwing getter, a Proxy, a frozen exotic) yields a minimal error carrying
 * the class name and redacted message, or `[unloggable error]`, never a throw.
 * Duck-typed on the message rather than `instanceof DrizzleQueryError` because
 * `instrument.js` is bundled separately from the app. An error with nothing to
 * redact, and any non-`Error` value, comes back as the same object.
 *
 * Call sites that route a caught database error on a name-writing path through
 * it: backend `errorHandler` (unhandled branch); auth `app.ts` `[PROVISION USER]`,
 * `[UPDATE IDENTITY]`, `[STATION SIGNUP]`, `[COMPLETE ONBOARDING]`; auth
 * `create-default-user.ts`. Sentry: backend and auth `instrument.ts` (`beforeSend`,
 * `beforeBreadcrumb`). better-auth's own logs: `authLogHandler` and the auth
 * process's console wrapper. Not scrubbed because they bind only ids and roles:
 * the `[PROVISION USER]` cleanup delete, the other `auth.definition.ts` hook
 * logs, and `fallbackErrorHandler`'s non-production response body. A new route
 * or job that catches such an error must log it through this function.
 */
export function redactQueryParams<T>(error: T): T {
  try {
    return isError(error) ? (redactError(error, 0) as T) : error;
  } catch {
    return minimalError(error) as T;
  }
}

/**
 * `value` with failed-query parameters removed, for anything that may be handed
 * to a logger: strings are scrubbed, errors go through `redactQueryParams`, and
 * arrays and plain objects are copied with their members redacted (to a bounded
 * depth). Anything else comes back as is. Total, like `redactQueryParams`.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  try {
    if (typeof value === 'string') return scrubText(value);
    if (isError(value)) return redactQueryParams(value);
    if (depth >= 3 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((member) => redactLogValue(member, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, redactLogValue(member, depth + 1)]));
  } catch {
    return UNLOGGABLE_VALUE;
  }
}

/** Frames Sentry cannot have parsed from a real `at` line: no line number and not an engine placeholder. */
function isBogusFrame(frame: { lineno?: number; filename?: string }): boolean {
  const filename = frame.filename ?? '';
  return frame.lineno === undefined && !/^(<|native|node:)/.test(filename);
}

/**
 * Sentry parses `error.stack` line by line into frames, and a message that holds
 * `\nparams: a, b` puts extra lines before the real `at` frames, so the last
 * words of the bound values come out as frames (`filename: "Test Reviewer"`).
 * The frames are ordered oldest first, so those land at the end: drop up to as
 * many trailing frames as the params part had lines.
 */
function dropParamsFrames(frames: { lineno?: number; filename?: string }[], paramsLines: number): void {
  for (
    let dropped = 0;
    dropped < paramsLines && frames.length > 0 && isBogusFrame(frames[frames.length - 1]);
    dropped++
  ) {
    frames.pop();
  }
}

/**
 * `beforeSend` for the Express servers: rewrites each exception value in the
 * event (the error and its `linkedErrors` causes) and drops the stack frames that
 * Sentry made out of the params lines. Breadcrumbs are scrubbed earlier, by
 * `redactSentryBreadcrumb`.
 */
export function redactSentryEventQueryParams(event: ErrorEvent): ErrorEvent {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value === undefined) continue;
    const at = exception.value.indexOf(PARAMS_MARKER);
    if (at !== -1 && exception.stacktrace?.frames) {
      dropParamsFrames(exception.stacktrace.frames, exception.value.slice(at).split('\n').length - 1);
    }
    exception.value = scrubText(exception.value);
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
