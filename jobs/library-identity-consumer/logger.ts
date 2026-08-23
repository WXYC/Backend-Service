/**
 * Observability for library-identity-consumer: Sentry init + JSON logs.
 *
 * Phase A foundation contract (issue #538): every log line carries the four
 * tags `repo`, `tool`, `step`, `run_id`. Sentry stays inactive when
 * SENTRY_DSN is unset (the @sentry/node SDK silently no-ops in that case),
 * so this module is safe to call from any environment.
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/logger.ts` and
 * `jobs/library-identity-backfill/logger.ts` verbatim — the contract is
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

/**
 * Emit a JSON log line. `info`/`warn` go to stdout, `error` goes to stderr
 * so container log shippers can split streams by severity. Silently no-ops
 * before initLogger() so unit tests that exercise library functions
 * directly don't have to thread an init call through every fixture.
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

export const captureError = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
  Sentry.captureException(error, { tags: { step }, extra });
};

export const closeLogger = async (): Promise<void> => {
  await Sentry.close(2000);
  baseTags = null;
};

/**
 * The PG diagnostic fields worth logging, lifted off a wrapped driver error.
 *
 * Drizzle wraps every postgres-js failure in a `DrizzleQueryError` whose
 * `.message` is hardcoded to `Failed query: <SQL>\nparams: <params>`. The part
 * that says what actually went wrong — the SQLSTATE code, the detail line, the
 * offending constraint or column — lives on `.cause`. Logging only `.message`
 * therefore produces a fleet of identical "Failed query" lines with no
 * diagnostic in any of them, which is exactly what the 2026-05-20 first run
 * emitted: many failures, one indistinguishable message, and no way to tell a
 * unique-violation from a not-null violation without a manual psql repro.
 *
 * Returned as a flat object so a caller can spread it straight into a `log()`
 * fields bag. Every field is `undefined` for a non-PG error, and
 * `JSON.stringify` drops undefined values, so a non-database failure logs
 * exactly as it did before — no empty `pg_*` keys, no shape change for the
 * consumers of these log lines.
 *
 * Deliberately total: `unknown` in, never throws. A catch block is the worst
 * possible place to add a new way to fail, so this reads defensively rather
 * than casting — a string thrown by a library, a null, or an error whose
 * `.cause` is itself a string all fall through to all-undefined.
 */
export type PgDiagnostics = {
  pg_message?: string;
  pg_code?: string;
  pg_detail?: string;
  pg_constraint?: string;
  pg_column?: string;
  pg_table?: string;
  pg_routine?: string;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const pgDiagnostics = (error: unknown): PgDiagnostics => {
  if (typeof error !== 'object' || error === null) return {};
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return {};
  const c = cause as Record<string, unknown>;
  return {
    pg_message: str(c.message),
    pg_code: str(c.code),
    pg_detail: str(c.detail),
    pg_constraint: str(c.constraint_name),
    pg_column: str(c.column_name),
    pg_table: str(c.table_name),
    pg_routine: str(c.routine),
  };
};

/**
 * `error.message` without the `(error as Error)` cast that throws on a thrown
 * string or null. Pairs with {@link pgDiagnostics} at every catch site.
 */
export const errorMessage = (error: unknown): string =>
  typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error);
