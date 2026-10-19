/**
 * Shared logger for the cron/one-shot jobs under `jobs/` (BS#3393, slice B3a): Sentry init
 * plus JSON log lines, with captures routed through an `ErrorReporter`. A job calls
 * `createJobLogger({ jobName })` at module load and re-exports what it needs.
 *
 * `Sentry.init` and the run-wide `repo` / `tool` / `run_id` tags stay here, imported from
 * `@sentry/node`, until B9; the reporter seam has no method for them.
 */

import * as Sentry from '@sentry/node';
import { randomUUID } from 'crypto';
import { SentryReporter } from './sentry-reporter.js';
import type { CounterFields, ErrorReporter } from './error-reporter.js';

export type LoggerConfig = {
  repo: string;
  tool: string;
  runId?: string;
};

export type LogLevel = 'info' | 'warn' | 'error';

type BaseTags = { repo: string; tool: string; run_id: string };

export const resolveTracesSampleRate = (raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE): number => {
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return 1;
  }
  return parsed;
};

/**
 * Defend against non-Error throws (`throw 'string'`, `throw { code: x }`) —
 * `(err as Error).message` would emit `undefined` and the JSON logger would drop the key.
 */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createJobLogger = ({ jobName }: { jobName: string }) => {
  let baseTags: BaseTags | null = null;
  const reporter: ErrorReporter = new SentryReporter();

  const initLogger = (config: LoggerConfig): string => {
    const runId = config.runId ?? randomUUID();
    baseTags = { repo: config.repo, tool: config.tool, run_id: runId };

    Sentry.init({
      // Sentry 11 turned this on by default, which titles captureMessage events
      // with a minified function name (BS#3002).
      attachStacktrace: false,
      // Sentry 11 installs Dedupe by default, which drops repeated identical events (BS#3005).
      integrations: (defaults) => defaults.filter((i) => i.name !== 'Dedupe'),
      dsn: process.env.SENTRY_DSN,
      release: process.env.SENTRY_RELEASE,
      environment: process.env.NODE_ENV || 'production',
      tracesSampleRate: resolveTracesSampleRate(),
    });
    Sentry.setTag('repo', config.repo);
    Sentry.setTag('tool', config.tool);
    Sentry.setTag('run_id', runId);

    return runId;
  };

  const log = (level: LogLevel, step: string, message: string, fields: Record<string, unknown> = {}): void => {
    if (!baseTags) {
      return;
    }
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, step, message, ...baseTags, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };

  const captureError = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
    reporter.captureException(error, { tags: { step }, extra });
  };

  /** Warning-level message (a condition, not a thrown error), fingerprinted per `jobName` and `step`. */
  const captureWarning = (message: string, step: string, extra: Record<string, unknown> = {}): void => {
    reporter.captureMessage(message, { level: 'warning', fingerprint: [jobName, step], tags: { step }, extra });
  };

  const captureMessage = (message: string, step: string, extra: Record<string, unknown> = {}): void => {
    reporter.captureMessage(message, { level: 'warning', tags: { step }, extra });
  };

  /** Counter that never breaks the job's main loop. */
  const captureCounter = (name: string, value: number, fields: CounterFields = {}): void => {
    try {
      reporter.recordCounter(name, value, fields);
    } catch (err) {
      console.warn(`logger: failed to emit counter metric "${name}"`, err);
    }
  };

  /** Drain the reporter, then close the Sentry client. Call from the entrypoint's `finally`. */
  const closeLogger = async (): Promise<void> => {
    await reporter.flush(2000);
    await Sentry.close(2000);
    baseTags = null;
  };

  return {
    initLogger,
    log,
    captureError,
    captureWarning,
    captureMessage,
    captureCounter,
    closeLogger,
    errorMessage,
    resolveTracesSampleRate,
    reporter,
  };
};
