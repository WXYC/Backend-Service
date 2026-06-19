/**
 * Observability for rotation-artist-backfill: Sentry init + JSON logs.
 *
 * Forked from `jobs/artist-search-alias-consumer/logger.ts` (same Phase A
 * `repo`/`tool`/`step`/`run_id` tag set; the duplication keeps the cron's
 * build graph decoupled). One intentional divergence: `resolveTracesSampleRate`
 * resolves any unusable `SENTRY_TRACES_SAMPLE_RATE` — unset OR malformed /
 * out-of-range — to 1.0, where the sibling resolves it to 0. See its doc
 * comment.
 */

import * as Sentry from '@sentry/node';
import { randomUUID } from 'crypto';

export type LoggerConfig = {
  repo: string;
  tool: string;
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
 * to 1.0 — matching the runtime apps (`apps/backend`, `apps/auth`). The
 * `rotation-artist-backfill.run.totals` span this job emits IS its product:
 * the BS#1402 alert rules (439423 / 439424) and the BS#1428 numeric-typing
 * verification read `sum(backfill.*)` off that span. Defaulting tracing to 0
 * makes those alerts dead-on-arrival — the span never reaches the index and
 * the alerts sit at "no data" forever (the BS#1428 finding: zero job spans in
 * 30 days because the cron's deploy env never set this var).
 *
 * The downshift lever is preserved: an explicit, valid `SENTRY_TRACES_SAMPLE_RATE=0`
 * still silences the job's spans. What changed is the resolved *default*: both
 * an unset value AND a malformed / out-of-range one now yield 1.0 (the sibling
 * yields 0 for both). Failing toward 1.0 rather than 0 is deliberate — a typo
 * while trying to retune must not silently disable this job's observability,
 * the very failure this fix addresses. Spans remain gated on `SENTRY_DSN`, so
 * dev/CI runs (no DSN) emit nothing regardless of rate.
 */
export const resolveTracesSampleRate = (raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE): number => {
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
  return parsed;
};

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

export const captureError = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
  Sentry.captureException(error, { tags: { step }, extra });
};

export const closeLogger = async (): Promise<void> => {
  await Sentry.close(2000);
  baseTags = null;
};
