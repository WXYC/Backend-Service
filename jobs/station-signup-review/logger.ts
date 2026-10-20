/**
 * The one logger instance for station-signup-review (BS#3400). `log()` is silent until this instance's
 * `initLogger` runs, so every file in the job imports from here; a second `createJobLogger`
 * call elsewhere would drop that file's log lines with no error.
 */

import { createJobLogger } from '@wxyc/observability/job-logger';

export const { initLogger, log, captureError, closeLogger } = createJobLogger({ jobName: 'station-signup-review' });

/**
 * Defend against non-Error throws (`throw 'string'`, `throw { code: x }`) --
 * `(err as Error).message` would emit `undefined` and the JSON logger would
 * drop the key. Also appends `error.cause.message` when present and
 * distinct -- Drizzle wraps driver errors as `DrizzleQueryError: Failed
 * query: ...` and hides the real failure on `.cause`.
 */
export const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined;
  return causeText && causeText !== error.message ? `${error.message} [cause: ${causeText}]` : error.message;
};
