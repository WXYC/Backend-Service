/**
 * Observability for flowsheet-metadata-backfill: Sentry init + JSON logs.
 *
 * Phase A foundation contract (issue #538): every log line carries the four
 * tags `repo`, `tool`, `step`, `run_id`. Sentry stays inactive when
 * SENTRY_DSN is unset (the @sentry/node SDK silently no-ops in that case),
 * so this module is safe to call from any environment.
 *
 * Mirrors `jobs/flowsheet-etl/logger.ts` verbatim — the contract is
 * identical, the duplication is to keep the one-shot job's build graph
 * independent of the long-running ETL package.
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

/**
 * Resolve the Sentry traces sample rate for this cron.
 *
 * Unlike the sibling ETL crons (flowsheet-etl, album-level-backfill, …) whose
 * loggers default an unset `SENTRY_TRACES_SAMPLE_RATE` to 0, this job defaults
 * to 1.0 — matching the runtime apps (`apps/backend`, `apps/auth`) and the
 * rotation-artist-backfill divergence pinned in PR #1459. The
 * `flowsheet-metadata-backfill.run.totals` span this job emits (op
 * `flowsheet-metadata-backfill.totals`) carries the `enrich_error` bucket —
 * the data-corruption tell (#1561) — so it IS this job's alerting substrate.
 * The #1560 wedge exited 1 nightly for ~2.5 weeks with nobody alerted;
 * defaulting tracing to 0 leaves any span-based alert dead-on-arrival, the span
 * never reaches the index, and the alert sits at "no data" forever.
 *
 * The downshift lever is preserved: an explicit, valid
 * `SENTRY_TRACES_SAMPLE_RATE=0` still silences the job's spans. What changed is
 * the resolved *default*: both an unset value AND a malformed / out-of-range
 * one now yield 1.0 (the sibling yields 0 for both). Failing toward 1.0 rather
 * than 0 is deliberate — a typo while retuning must not silently disable this
 * job's observability, the very failure this fix addresses. Spans remain gated
 * on `SENTRY_DSN`, so dev/CI runs (no DSN) emit nothing regardless of rate.
 */
export const resolveTracesSampleRate = (raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE): number => {
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
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
