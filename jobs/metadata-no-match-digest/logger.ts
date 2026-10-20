/**
 * The one logger instance for metadata-no-match-digest (BS#3400). `log()` is silent until this instance's
 * `initLogger` runs, so every file in the job imports from here; a second `createJobLogger`
 * call elsewhere would drop that file's log lines with no error.
 */

import { createJobLogger } from '@wxyc/observability/job-logger';

export const { initLogger, log, captureError, closeLogger } = createJobLogger({ jobName: 'metadata-no-match-digest' });

/**
 * Defend against non-Error throws (`throw 'string'`, `throw { code: x }`) --
 * `(err as Error).message` would emit `undefined` and the JSON logger would
 * drop the key. The canonical safe pattern from
 * flowsheet-metadata-backfill/orchestrate.ts.
 *
 * Also appends `error.cause.message` when present and distinct: Drizzle wraps
 * driver errors as `DrizzleQueryError: Failed query: <sql>` and hides the real
 * failure (a PG error, or the postgres-js/Node `TypeError` from the date
 * serializer passthrough -- see `query.ts`) on `.cause`. Logging only
 * `.message` made the original enriched_no_match-digest failure undiagnosable
 * from stdout; surfacing the cause mirrors BS#975's observability fix.
 */
export const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  // Only Error and string causes are surfaced -- the realistic shapes here
  // (Drizzle wraps an underlying driver Error; a `throw 'msg'` carries a
  // string). An exotic object cause is left off rather than emit a useless
  // `[object Object]`.
  const cause: unknown = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined;
  return causeText && causeText !== error.message ? `${error.message} [cause: ${causeText}]` : error.message;
};
