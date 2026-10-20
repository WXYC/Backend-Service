/**
 * The one logger instance for library-identity-consumer (BS#3400). `log()` is silent until this instance's
 * `initLogger` runs, so every file in the job imports from here; a second `createJobLogger`
 * call elsewhere would drop that file's log lines with no error.
 */

import { createJobLogger } from '@wxyc/observability/job-logger';

export const { initLogger, log, captureError, closeLogger } = createJobLogger({ jobName: 'library-identity-consumer' });

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
