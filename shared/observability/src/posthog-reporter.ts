import { AsyncLocalStorage } from 'node:async_hooks';
import { PostHog } from 'posthog-node';
import type { ErrorReporter, ReportBreadcrumb, ReportContext } from './error-reporter.js';
import { redactLogValue, redactQueryParams } from './redact-query-params.js';

/**
 * `ErrorReporter` over posthog-node, sending `$exception` events to the "Services" project
 * (BS#3393, slice B6a). The event shape, budgets and dedupe follow WXYC/wiki
 * `patterns/error-tracking.md`. Fail-open: no `POSTHOG_ERRORS_API_KEY` means every call is a no-op,
 * and nothing here throws. It imports no per-module-copy state; the process-wide reporter slot is
 * the holder in `current-reporter.ts`.
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

interface Scope {
  crumbs: Array<Record<string, unknown>>;
  tags: Record<string, string>;
}

const newScope = (): Scope => ({ crumbs: [], tags: {} });

/** Unset or unknown (`test`, `prod`) is production, so a production process that lacks NODE_ENV is never tagged as development. */
const mapEnvironment = (raw: string | undefined): 'production' | 'staging' | 'development' =>
  raw === 'staging' || raw === 'development' ? raw : 'production';

export class PostHogReporter implements ErrorReporter {
  private readonly client: PostHog | null = null;
  private readonly environment: string;
  private readonly requestScopes = new AsyncLocalStorage<Scope>();
  /** Used outside `runInScope`: a job's one run, or an app before its middleware opens a scope per request. */
  private readonly processScope = newScope();
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
      this.client = new PostHog(apiKey, { host: process.env.POSTHOG_HOST || DEFAULT_HOST });
    } catch (err) {
      console.warn(`PostHogReporter disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Runs `fn` with its own breadcrumb trail and request tags, so concurrent requests do not share them. */
  runInScope<T>(fn: () => T): T {
    return this.requestScopes.run(newScope(), fn);
  }

  captureException(err: unknown, context?: ReportContext): void {
    const fingerprint = context?.fingerprint?.join(':');
    const key = fingerprint ?? (err instanceof Error ? `${err.name}:${err.message}` : String(err));
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

  captureMessage(message: string, context?: ReportContext): void {
    const fingerprint = context?.fingerprint?.join(':') ?? message;
    this.send(fingerprint, () => {
      const value = String(redactLogValue(message));
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
    const { crumbs } = this.scope();
    crumbs.push(redactLogValue({ ...crumb, timestamp: new Date().toISOString() }) as Record<string, unknown>);
    if (crumbs.length > BREADCRUMB_RING_SIZE) {
      crumbs.shift();
    }
  }

  setRequestTag(key: string, value: string): void {
    this.scope().tags[key] = value;
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

  private scope(): Scope {
    return this.requestScopes.getStore() ?? this.processScope;
  }

  /** The properties on every event; the contract fields come last so tags and run-wide properties cannot override them. */
  private properties(context?: ReportContext): Record<string, unknown> {
    const { tags, crumbs } = this.scope();
    const extra = context?.extra ? { extra: redactLogValue(context.extra) } : {};
    return {
      ...context?.tags,
      ...this.options.properties,
      ...tags,
      ...extra,
      ...(crumbs.length > 0 ? { breadcrumbs: crumbs } : {}),
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
