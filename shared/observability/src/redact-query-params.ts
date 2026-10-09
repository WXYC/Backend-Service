import { types } from 'node:util';
import { exceptionFromError, getClient, isError as isSentryError } from '@sentry/core';
import type { Breadcrumb, ErrorEvent, EventHint, Exception, StackFrame } from '@sentry/core';

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
/**
 * Backstop for the Sentry rebuild only: a params marker followed by anything but the whole redaction. It reads
 * content, and a bound value can imitate it (`[redacted]\n    at ...`), so nothing that decides what is
 * cut or copied uses it; those decisions go by the position of the marker.
 */
const UNREDACTED_PARAMS = /\nparams: (?!\[redacted\](?:\n {4}at |$))/;
const FAILING_ROW = /^Failing row contains \(/;
const REDACTED_FAILING_ROW = 'Failing row contains ([redacted])';
const MAX_DEPTH = 8;
/** How many distinct errors `rawChainHoldsParams` visits before it gives up; well above any real chain or `AggregateError`. */
const WALK_BUDGET = 10_000;

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
 * Decided by position, never by what follows a marker (a bound value can imitate a redaction):
 * - a stack that does not embed the message, or holds a marker before it, is cut at its first marker;
 * - so is one whose message span holds a marker unless the error is `intact`: its message is exactly the
 *   one it builds from its own `query` and `params` (a drizzle error), or it is a copy `redactError` made (its
 *   `params` is the redaction, so that check cannot say so), and the frames start right after it.
 *   Anything else (a message cut at or after the marker, or a plain error that carries no query to check
 *   it against) leaves the rest of the params line, or a bound value's own `\n    at ` line, after the span;
 * - otherwise the text after the message is cut at its first marker (a message shortened before the marker).
 */
function scrubStack(stack: string, message: string, scrubbedMessage: string, intact: boolean): string {
  const at = stack.indexOf(message);
  const first = stack.indexOf(PARAMS_MARKER);
  if (at === -1 || (first !== -1 && first < at)) return scrubText(stack);
  const end = at + message.length;
  if (first !== -1 && first < end && !(intact && /^(?:\n {4}at |$)/.test(stack.slice(end)))) return scrubText(stack);
  return stack.slice(0, at) + scrubbedMessage + scrubText(stack.slice(end));
}

function carriesRow(error: Error): boolean {
  const { detail } = error as { detail?: unknown };
  return typeof detail === 'string' && FAILING_ROW.test(detail);
}

/**
 * What Sentry follows as an error, so the guards walk exactly what it walks: `instanceof Error` misses errors from
 * another realm (Node core errors under a vm context), so also ask the engine, and Sentry also takes an object
 * tagged `[object Error]` (and its other error tags) as a `cause` or an `errors` member.
 */
function isError(value: unknown): value is Error {
  return value instanceof Error || types.isNativeError(value) || copies.has(value as object) || isSentryError(value);
}

/** The copies `redactError` made: a copy of a cross-realm error is no longer native, yet must still be followed down a cause chain, and a copy counts as `intact` when it is redacted again. */
const copies = new WeakSet<object>();

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
  // A stack formatted before the message was shortened can still hold a params line: that error is copied so `scrubStack` cuts it.
  // Read once and used for every decision below, so a stateful `stack` accessor cannot leave the raw stack on the copy.
  const rawStack: unknown = error.stack;
  const stackHoldsParams = String(rawStack).includes(PARAMS_MARKER);
  if (message === rawMessage && cause === error.cause && !hasParamProperty && !carriesRow(error) && !stackHoldsParams)
    return error;

  // Same class, and every own property (code, status, expose, ...) as a plain value;
  // only the value-bearing ones change. A property whose getter throws is left out.
  const clean: Error = Object.create(Object.getPrototypeOf(error));
  const set = (key: string | symbol, value: unknown, enumerable: boolean) =>
    Object.defineProperty(clean, key, { value, enumerable, writable: true, configurable: true });
  for (const key of Reflect.ownKeys(error)) {
    if (key === 'stack') continue;
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
  const { query: rawQuery, params } = error as { query?: unknown; params?: unknown };
  // A copy is redacted again like any error, but counts as intact: its frames start right after its message, and its `params` is the redaction, so the check below could not say so.
  const intact =
    copies.has(error) ||
    (typeof rawQuery === 'string' &&
      Array.isArray(params) &&
      rawMessage === `Failed query: ${rawQuery}${PARAMS_MARKER}${params}`);
  if (typeof rawStack === 'string') set('stack', scrubStack(rawStack, rawMessage, message, intact), false);
  // An own `undefined` hides any `stack` accessor the copy would inherit, whatever it answers on later reads.
  else set('stack', undefined, false);
  if (Object.hasOwn(error, 'cause')) set('cause', cause, false);
  for (const key of PARAM_PROPERTIES) {
    if (Object.hasOwn(error, key)) set(key, '[redacted]', Object.prototype.propertyIsEnumerable.call(error, key));
  }
  const { query } = error as { query?: unknown };
  if (typeof query === 'string')
    set('query', scrubText(query), Object.prototype.propertyIsEnumerable.call(error, 'query'));
  if (carriesRow(error)) set('detail', REDACTED_FAILING_ROW, true);
  copies.add(clean);
  return clean;
}

/** The least that is still useful when the full copy cannot be made: class name and redacted message. */
function minimalError(error: unknown): Error | string {
  try {
    const { name, message } = error as Error;
    const safe = new Error(scrubText(String(message)));
    safe.name = String(Object.getPrototypeOf(error)?.constructor?.name ?? name);
    // Its own stack would be the helper's call stack, and the rebuild would send that as the throw site.
    delete safe.stack;
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
 * the class name and redacted message (no stack), or `[unloggable error]`, never a throw.
 * Duck-typed on the message rather than `instanceof DrizzleQueryError` because
 * `instrument.js` is bundled separately from the app. An error with nothing to
 * redact, and any non-`Error` value, comes back as the same object.
 *
 * Which call sites use it, and what it leaves unredacted, is in docs/pii.md, "Failed-query
 * parameters: how the redaction works and what it leaves". A new route or job that catches
 * such an error must log it through this function.
 */
export function redactQueryParams<T>(error: T): T | Error | string {
  try {
    return isError(error) ? redactError(error, 0) : error;
  } catch {
    return minimalError(error);
  }
}

/**
 * `value` with failed-query parameters removed, for anything that may be handed
 * to a logger: strings are scrubbed, errors go through `redactQueryParams`, and
 * arrays and plain objects have their members redacted (to a bounded depth). A
 * value with nothing to redact comes back as the same object, so how a logger
 * prints it (getters, symbol keys, null prototypes, cycles) is unchanged; one
 * that does change is copied. Accessor properties are never invoked and are left
 * as they are. Total, like `redactQueryParams`.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  try {
    if (typeof value === 'string') return scrubText(value);
    if (isError(value)) return redactQueryParams(value);
    if (depth >= 3 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      const members = value.map((member) => redactLogValue(member, depth + 1));
      return members.some((member, i) => member !== value[i]) ? members : value;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const changed: [string, unknown][] = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const member = redactLogValue(descriptor.value, depth + 1);
      if (member !== descriptor.value) changed.push([key, member]);
    }
    if (changed.length === 0) return value;
    // A copy with every descriptor intact (accessors uncalled, symbols kept), made configurable so the changed members can be set.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) descriptor.configurable = true;
    const copy = Object.create(prototype, descriptors);
    for (const [key, member] of changed) Object.defineProperty(copy, key, { value: member, writable: true });
    return copy;
  } catch {
    return UNLOGGABLE_VALUE;
  }
}

/** The context lines Sentry's contextLines integration attached to a frame, which a rebuilt frame lacks. */
const CONTEXT_KEYS = ['pre_context', 'context_line', 'post_context'] as const;

/**
 * Sentry parses `error.stack` into frames before `beforeSend` runs, so the params
 * lines of a failed query's message become frames carrying bound values, and no
 * frame heuristic can tell them from real ones (a bound timestamp gives
 * `Reviewer,DJ Cool,2026-10-08T16` a line number). Instead each exception value is
 * rebuilt from the redacted error with Sentry's own parser, whose input has no
 * params lines. The cause chain is matched by position: the thrown error is the
 * last value and each `cause` precedes it. Context lines are carried over from
 * the original frame at the same location. Returns the values it rebuilt.
 */
function rebuildExceptionValues(values: Exception[], original: unknown): Set<Exception> {
  const rebuilt = new Set<Exception>();
  const stackParser = getClient()?.getOptions().stackParser;
  if (!stackParser || !isError(original)) return rebuilt;
  let link: unknown = redactQueryParams(original);
  // `redactError` copies the thrown error and `MAX_DEPTH` causes; a link past that is the raw error.
  let i = 0;
  for (; i < values.length && i <= MAX_DEPTH && isError(link); i++, link = (link as Error).cause) {
    const target = values[values.length - 1 - i];
    // Content backstop. A link the copy chain does not own reaches it: a copy with no own `cause` inherits a
    // `cause` getter that hands back the raw inner error (`copy.cause` is then not a copy), and there this check
    // is the only thing keeping that error's params line out of the frames. Everywhere else the copy's stack was
    // cut by position first (a copy that was written back to is redacted again, and its `stack` is always its
    // own), and `i <= MAX_DEPTH` keeps raw links out of the loop.
    if (UNREDACTED_PARAMS.test(String(link.stack))) {
      delete target.stacktrace;
      break;
    }
    const fresh = exceptionFromError(stackParser, link);
    // A different class means the chain does not line up (an AggregateError added values): leave it to the fallback.
    if (fresh.type !== target.type) break;
    const before = target.stacktrace?.frames ?? [];
    for (const frame of fresh.stacktrace?.frames ?? []) {
      const same = before.find(
        (old: StackFrame) =>
          old.filename === frame.filename &&
          old.lineno === frame.lineno &&
          old.colno === frame.colno &&
          old.function === frame.function
      );
      for (const key of CONTEXT_KEYS) if (same?.[key] !== undefined) Object.assign(frame, { [key]: same[key] });
    }
    target.value = fresh.value;
    if (fresh.stacktrace) target.stacktrace = fresh.stacktrace;
    else delete target.stacktrace;
    rebuilt.add(target);
  }
  // Values the loop did not reach are the raw errors (past the bound) or ones it could not match (a minimal-error
  // fallback, a class mismatch, a link without a `cause`): they get no stacktrace if a raw error in the chain held a
  // marker. Only that decides: a chain that never held one (a long chain, a big AggregateError) is left as Sentry built it.
  if (i < values.length && rawChainHoldsParams(original)) {
    for (const unreached of values.slice(0, values.length - i)) delete unreached.stacktrace;
  }
  return rebuilt;
}

/**
 * Whether `error`, its `cause` chain or its `errors` (to any depth and fan-out, each error once, so a cycle ends)
 * holds a params marker in its stack. True only when one does, when the walk throws (a getter, a Proxy), or when it
 * passes `WALK_BUDGET` distinct errors (a getter that builds a fresh error on every read): it cannot tell then.
 */
function rawChainHoldsParams(error: unknown): boolean {
  try {
    const seen = new Set<unknown>();
    const pending: unknown[] = [error];
    while (pending.length > 0) {
      const next = pending.pop();
      if (!isError(next) || seen.has(next)) continue;
      // A getter that builds a new error on every read has no end: past this many errors the walk cannot tell, and answers true.
      if (seen.size >= WALK_BUDGET) return true;
      seen.add(next);
      if (String(next.stack).includes(PARAMS_MARKER)) return true;
      const { errors } = next as { errors?: unknown };
      pending.push(next.cause);
      // Only errors are queued, so a hole or a non-error in a huge `errors` array fills nothing (the visit itself is linear in its length).
      if (Array.isArray(errors)) {
        errors.forEach((member) => {
          if (isError(member)) pending.push(member);
        });
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** `scrubText` on every string reachable from `node` (plain objects and arrays, to a bounded depth), in place. */
function scrubStrings(node: unknown, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  const holder = node as Record<string, unknown>;
  for (const key of Object.keys(holder)) {
    const member = holder[key];
    if (typeof member === 'string') holder[key] = scrubText(member);
    else scrubStrings(member, depth + 1);
  }
}

/**
 * `beforeSend` for the Express servers. Each exception value in the event (the
 * error and its `linkedErrors` causes) is rebuilt, message and stack, from
 * `hint.originalException` redacted by `redactQueryParams`. When there is no
 * original exception, or a value cannot be matched to the chain, the value is
 * scrubbed in place and its stack is dropped if the message held a params part,
 * since frames made from those lines cannot be told from real ones. A last pass
 * scrubs every string in the event, so a failed rebuild can never send the raw
 * text. Breadcrumbs are scrubbed earlier, by `redactSentryBreadcrumb`.
 */
export function redactSentryEventQueryParams(event: ErrorEvent, hint?: EventHint): ErrorEvent {
  const values = event.exception?.values ?? [];
  let rebuilt = new Set<Exception>();
  try {
    rebuilt = rebuildExceptionValues(values, hint?.originalException);
  } catch {
    // fall through to the in-place scrub of every value
  }
  for (const exception of values) {
    if (rebuilt.has(exception) || exception.value === undefined) continue;
    if (exception.value.includes(PARAMS_MARKER)) delete exception.stacktrace;
    exception.value = scrubText(exception.value);
  }
  scrubStrings(event);
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
