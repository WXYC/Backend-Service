/**
 * Observability for triangle-shows-etl: Sentry init + JSON logs.
 *
 * Copied from `jobs/venue-events-scraper/logger.ts` (the issue-#538
 * contract; per-job duplication keeps this job's build graph independent
 * of the long-running services) PLUS one deliberate addition this copy
 * carries that the siblings don't: `captureWarning`, the message-level
 * Sentry signal the source-staleness alert depends on. When propagating
 * logger fixes across the job fleet, do NOT "restore verbatim" by
 * deleting it — and note `jobs/flowsheet-metadata-backfill/logger.ts`
 * has separately diverged (tracesSampler work, BS#1457/#1566), so it is
 * not a sync source for cron jobs that default tracing off.
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

/** Warning-level Sentry message (no exception object) — used for the
 *  source-staleness signal, which is a condition, not a thrown error.
 *  Message-based, so it needs no tracing (BS crons default
 *  SENTRY_TRACES_SAMPLE_RATE=0; span-attribute alerts would be
 *  dead-on-arrival here, see BS#1457). */
export const captureWarning = (message: string, step: string, extra: Record<string, unknown> = {}): void => {
  Sentry.captureMessage(message, { level: 'warning', tags: { step }, extra });
};

export const closeLogger = async (): Promise<void> => {
  await Sentry.close(2000);
  baseTags = null;
};
