import { AsyncLocalStorage } from 'node:async_hooks';
import { PostHog } from 'posthog-node';
import type { BeforeSendFn } from 'posthog-node';
import type { ErrorReporter, ReportBreadcrumb, ReportContext } from './error-reporter.js';
import { redactLogValue, redactQueryParams, scrubEventStrings } from './redact-query-params.js';

/**
 * `ErrorReporter` over posthog-node, sending `$exception` events to the "Services" project
 * (BS#3393, slice B6a). The event shape, budgets and dedupe follow WXYC/wiki
 * `patterns/error-tracking.md`. Fail-open: no `POSTHOG_ERRORS_API_KEY` means every call is a no-op,
 * and nothing here throws. It imports no per-module-copy state; the process-wide reporter slot is
 * the holder in `current-reporter.ts`.
 *
 * Request scope: breadcrumbs and request tags are kept per request in an AsyncLocalStorage opened by
 * `runInScope`. An HTTP app MUST wrap each request in `runInScope` (BS#3409 wires that middleware);
 * without it, `setRequestTag` is a no-op, because a tag kept process-wide would leak one request's
 * `request_id` onto another request's events. Outside a scope, breadcrumbs go to a small bounded
 * process-level ring, which is right for a job: one flow per process.
 */

/** `daily`: a long-running process (capacity 20, refills `ceiling` a day). `run`: a scheduled run (capacity `ceiling`, no refill). */
export type PostHogBudget = { kind: 'daily'; ceiling: number } | { kind: 'run'; ceiling: number };

export interface PostHogReporterOptions {
  /** App or job name; becomes the `service` property and the `distinct_id`. */
  service: string;
  /** The raw environment source, normally `process.env.NODE_ENV`; mapped to production, staging or development. */
  environment?: string;
  /** Omitted from the event when undefined or empty. */
  release?: string;
  budget: PostHogBudget;
  /** Static run-wide properties (`repo`, `tool`, `run_id`); the reporter's own fields win on a clash. */
  properties?: Record<string, string>;
}

const DEFAULT_HOST = 'https://us.i.posthog.com';
const DAILY_CAPACITY = 20;
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 1000;
const DROP_LOG_INTERVAL_MS = 60_000;
/** Breadcrumbs kept per scope: half of Sentry's default of 100, enough to show the lead-up without bloating an event. */
const BREADCRUMB_RING_SIZE = 50;
/** The outside-scope ring is smaller: a job needs the lead-up, and a missing wrapper should leak little. */
const PROCESS_RING_SIZE = 20;

/** Mechanism types for a process crash (error-tracking contract, section 4); both are sent `handled: false`. */
export type CrashMechanism = 'onuncaughtexception' | 'onunhandledrejection';

/**
 * posthog-node's public `captureException` always stamps `handled: true` and takes no mechanism hint, so a crash
 * carries its mechanism in this property and `redactPostHogEvent` rewrites the first `$exception_list` entry from it.
 */
const CRASH_MARKER = '$wxyc_crash_mechanism';

/** Upper bound on the PostHog flush a crash handler waits for before it exits. */
const CRASH_FLUSH_MS = 2000;

interface Scope {
  crumbs: Array<Record<string, unknown>>;
  tags: Record<string, string>;
}

const newScope = (): Scope => ({ crumbs: [], tags: {} });

const fingerprintOf = (err: unknown): string => {
  if (err instanceof Error) {
    return `${err.name}:${err.message}`;
  }
  if (typeof err !== 'object' || err === null) {
    return String(err);
  }
  try {
    const record = err as Record<string, unknown>;
    const name = err.constructor?.name ?? 'Object';
    const label = [record['message'], record['code']].find((v) => typeof v === 'string' || typeof v === 'number');
    if (label !== undefined) {
      return `${name}:${String(label)}`;
    }
    const parts = Object.keys(record)
      .sort()
      .map((k) => (['string', 'number', 'boolean'].includes(typeof record[k]) ? `${k}=${String(record[k])}` : k));
    let hash = 0;
    for (const ch of parts.join('|')) {
      hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
    }
    return `${name}:#${(hash >>> 0).toString(16)}`;
  } catch {
    return 'Object:unkeyable';
  }
};

/** Unset or unknown (`test`, `prod`) is production, so a production process that lacks NODE_ENV is never tagged as development. */
const mapEnvironment = (raw: string | undefined): 'production' | 'staging' | 'development' =>
  raw === 'staging' || raw === 'development' ? raw : 'production';

/**
 * posthog-node `before_send` (BS#3054 on the PostHog path): the every-string scrub over the whole outgoing event,
 * after the SDK has merged tags, run-wide properties and the `$exception_list` it builds from the error and its
 * `cause` chain. The inputs are redacted earlier, so this is the backstop for what they miss. It fails closed:
 * an event the scrub cannot walk is dropped, never sent raw.
 */
const redactPostHogEvent: BeforeSendFn = (event) => {
  if (!event) {
    return event;
  }
  try {
    const list: unknown = event.properties?.['$exception_list'];
    const crash: unknown = event.properties?.[CRASH_MARKER];
    const first = Array.isArray(list) ? (list[0] as { mechanism?: object } | undefined) : undefined;
    if (typeof crash === 'string' && first) {
      first.mechanism = { ...first.mechanism, type: crash, handled: false };
    }
    delete event.properties?.[CRASH_MARKER];
    scrubEventStrings(event, Array.isArray(list) ? list : []);
    return event;
  } catch {
    return null;
  }
};

export class PostHogReporter implements ErrorReporter {
  private readonly client: PostHog | null = null;
  private readonly environment: string;
  private readonly requestScopes = new AsyncLocalStorage<Scope>();
  /** Breadcrumbs outside `runInScope` (a job's one run). Request tags are never kept here. */
  private readonly processCrumbs: Array<Record<string, unknown>> = [];
  private warnedNoScope = false;
  /** Errors a call site already reported, so a rethrow that reaches the crash handler is not sent twice. */
  private readonly captured = new WeakSet<object>();
  private readonly recentKeys = new Map<string, number>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill = Date.now();
  private dropped = 0;
  private lastDropLog = 0;

  constructor(private readonly options: PostHogReporterOptions) {
    this.environment = mapEnvironment(options.environment);
    const { kind, ceiling } = options.budget;
    this.capacity = kind === 'daily' ? DAILY_CAPACITY : ceiling;
    this.refillPerMs = kind === 'daily' ? ceiling / 86_400_000 : 0;
    this.tokens = this.capacity;

    const apiKey = process.env.POSTHOG_ERRORS_API_KEY;
    if (!apiKey) {
      return;
    }
    try {
      this.client = new PostHog(apiKey, {
        host: process.env.POSTHOG_HOST || DEFAULT_HOST,
        before_send: redactPostHogEvent,
      });
    } catch (err) {
      console.warn(`PostHogReporter disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Runs `fn` with its own breadcrumb trail and request tags, so concurrent requests do not share them. */
  runInScope<T>(fn: () => T): T {
    return this.requestScopes.run(newScope(), fn);
  }

  /** True when a key is configured and the client built; crash handlers install only then. */
  get enabled(): boolean {
    return this.client !== null;
  }

  captureException(err: unknown, context?: ReportContext): void {
    if (typeof err === 'object' && err !== null) {
      this.captured.add(err);
    }
    const fingerprint = context?.fingerprint?.join(':');
    const key = fingerprint ?? fingerprintOf(err);
    this.send(key, () => {
      // posthog-node sets `$exception_level: "error"` itself and a caller value overrides it silently,
      // so a level is passed only when it differs.
      const level = context?.level === 'warning' ? { $exception_level: 'warning' } : {};
      this.client?.captureException(redactQueryParams(err), this.options.service, {
        ...this.properties(context),
        ...(fingerprint === undefined ? {} : { $exception_fingerprint: fingerprint }),
        ...level,
      });
    });
  }

  /**
   * Reports a process crash with `handled: false`, through the same dedupe window and token bucket as handled events.
   * PostHog-only on purpose: Sentry gets the crash from its own integration, so routing this through the composite
   * would count it twice there. An error a call site already captured is skipped.
   */
  captureCrash(err: unknown, mechanism: CrashMechanism): void {
    if (typeof err === 'object' && err !== null && this.captured.has(err)) {
      return;
    }
    this.send(fingerprintOf(err), () => {
      this.client?.captureException(redactQueryParams(err), this.options.service, {
        ...this.properties(),
        [CRASH_MARKER]: mechanism,
      });
    });
  }

  captureMessage(message: string, context?: ReportContext): void {
    const value = String(redactLogValue(message));
    const fingerprint = context?.fingerprint?.join(':') ?? value;
    this.send(fingerprint, () => {
      this.client?.capture({
        distinctId: this.options.service,
        event: '$exception',
        properties: {
          ...this.properties(context),
          $exception_list: [{ type: 'Message', value, mechanism: { type: 'generic', handled: true, synthetic: true } }],
          $exception_types: ['Message'],
          $exception_fingerprint: fingerprint,
          $exception_level: context?.level === 'warning' ? 'warning' : 'error',
        },
      });
    });
  }

  addBreadcrumb(crumb: ReportBreadcrumb): void {
    if (!this.client) {
      return;
    }
    const scope = this.requestScopes.getStore();
    const crumbs = scope ? scope.crumbs : this.processCrumbs;
    crumbs.push(redactLogValue({ ...crumb, timestamp: new Date().toISOString() }) as Record<string, unknown>);
    if (crumbs.length > (scope ? BREADCRUMB_RING_SIZE : PROCESS_RING_SIZE)) {
      crumbs.shift();
    }
  }

  setRequestTag(key: string, value: string): void {
    const scope = this.requestScopes.getStore();
    if (scope) {
      scope.tags[key] = value;
    } else if (this.client && !this.warnedNoScope) {
      this.warnedNoScope = true;
      console.warn('PostHogReporter.setRequestTag ignored outside runInScope; wrap each request in runInScope');
    }
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.client) {
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.client.flush().then(() => true), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The properties on every event; the contract fields come last so tags and run-wide properties cannot override them. */
  private properties(context?: ReportContext): Record<string, unknown> {
    const scope = this.requestScopes.getStore();
    const tags = scope?.tags;
    const crumbs = scope ? scope.crumbs : this.processCrumbs;
    const extra = context?.extra ? { extra: redactLogValue(context.extra) } : {};
    return {
      ...context?.tags,
      ...this.options.properties,
      ...tags,
      ...extra,
      ...(crumbs.length > 0 ? { breadcrumbs: [...crumbs] } : {}),
      service: this.options.service,
      environment: this.environment,
      ...(this.options.release ? { release: this.options.release } : {}),
      $process_person_profile: false,
    };
  }

  /** Runs `send` only if the key is not a repeat inside the dedupe window and the bucket has a token; never throws. */
  private send(key: string, send: () => void): void {
    if (!this.client) {
      return;
    }
    try {
      if (this.admit(key)) {
        send();
      }
    } catch {
      // observability must not break the path it observes
    }
  }

  /** Dedupe first, so a suppressed repeat costs no token. */
  private admit(key: string): boolean {
    const now = Date.now();
    const seen = this.recentKeys.get(key);
    if (seen !== undefined && now - seen < DEDUPE_WINDOW_MS) {
      return this.drop(now);
    }
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
    if (this.tokens < 1) {
      return this.drop(now);
    }
    this.tokens -= 1;
    this.recentKeys.delete(key);
    this.recentKeys.set(key, now);
    if (this.recentKeys.size > DEDUPE_MAX_KEYS) {
      this.recentKeys.delete(this.recentKeys.keys().next().value as string);
    }
    return true;
  }

  private drop(now: number): false {
    this.dropped += 1;
    if (now - this.lastDropLog >= DROP_LOG_INTERVAL_MS) {
      console.warn(`PostHogReporter dropped ${this.dropped} event(s) (budget or dedupe) for ${this.options.service}`);
      this.dropped = 0;
      this.lastDropLog = now;
    }
    return false;
  }
}

/**
 * Installs the `uncaughtException` and `unhandledRejection` handlers that report crashes to PostHog, and returns a
 * function that removes them. Installs nothing (returns a no-op) when the reporter has no key.
 *
 * Exit ownership: @sentry/node 11.4's `onUncaughtExceptionIntegration` exits only when no other `uncaughtException`
 * listener is registered (`exitEvenIfOtherHandlersAreRegistered` defaults to false), so once this one is installed
 * it owns the non-zero exit. It flushes PostHog and `beforeExit` (the apps pass `Sentry.close`, so Sentry's own
 * crash event is not cut short), each bounded to 2 s, then exits 1. Sentry's `onUnhandledRejection` default mode
 * only warns, so a rejection is reported and the process carries on, as before.
 */
export function installCrashHandlers(
  reporter: PostHogReporter,
  beforeExit: () => Promise<unknown> = () => Promise.resolve()
): () => void {
  if (!reporter.enabled) {
    return () => undefined;
  }
  let exiting = false;
  const onException = (err: unknown): void => {
    reporter.captureCrash(err, 'onuncaughtexception');
    if (exiting) {
      return;
    }
    exiting = true;
    console.error(err);
    void Promise.allSettled([reporter.flush(CRASH_FLUSH_MS), beforeExit()]).then(() => process.exit(1));
  };
  const onRejection = (reason: unknown): void => {
    reporter.captureCrash(reason, 'onunhandledrejection');
    void reporter.flush(CRASH_FLUSH_MS);
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}
