/**
 * Observability for album-level-backfill: Sentry init + JSON logs.
 *
 * Every log line carries the four tags `repo`, `tool`, `step`, `run_id` so
 * downstream consumers (the BS#1078 Phase 3 runbook's `jq` watchdog, the
 * Loki/CloudWatch pipeline) can filter by step without a regex over
 * free-form prose. Sentry stays inactive when SENTRY_DSN is unset (the
 * @sentry/node SDK silently no-ops in that case), so this module is safe to
 * call from any environment.
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/logger.ts` verbatim — the
 * contract is identical, the duplication is the established pattern for
 * keeping each one-shot job's build graph independent of the others.
 */

import * as Sentry from '@sentry/node';
import { randomUUID } from 'crypto';

export type LoggerConfig = {
  repo: string;
  tool: string;
  /** Optional run id; a random UUID is generated when omitted. */
  runId?: string;
};

export type LogLevel = 'info' | 'warn' | 'error';

type BaseTags = { repo: string; tool: string; run_id: string };

let baseTags: BaseTags | null = null;

// `@sentry/node` v10 silently produces zero spans when tracesSampleRate is unset.
export const resolveTracesSampleRate = (raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE): number => {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0;
  return parsed;
};

/**
 * Initialize Sentry and the structured logger. Call once at the top of the
 * entrypoint, before any other logic. Returns the resolved `run_id` so the
 * caller can pass it to subprocesses or persist it for cross-system tracing.
 */
export const initLogger = (config: LoggerConfig): string => {
  const runId = config.runId ?? randomUUID();
  baseTags = { repo: config.repo, tool: config.tool, run_id: runId };

  Sentry.init({
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

/**
 * Emit a JSON log line. `info`/`warn` go to stdout, `error` goes to stderr
 * so container log shippers can split streams by severity.
 *
 * Silently no-ops when called before `initLogger()` so unit tests that
 * exercise library functions directly (without invoking the entrypoint)
 * don't have to thread an init call through every fixture.
 */
export const log = (level: LogLevel, step: string, message: string, fields: Record<string, unknown> = {}): void => {
  if (!baseTags) return;
  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      step,
      message,
      ...baseTags,
      ...fields,
    }) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

/** Capture an exception to Sentry with the current run's tags + an extra `step`. */
export const captureError = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
  Sentry.captureException(error, { tags: { step }, extra });
};

/** Flush pending Sentry events. Call from the entrypoint's `finally`. */
export const closeLogger = async (): Promise<void> => {
  await Sentry.close(2000);
  baseTags = null;
};
