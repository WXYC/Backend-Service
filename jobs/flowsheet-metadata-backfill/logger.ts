/**
 * The one logger instance for flowsheet-metadata-backfill (BS#3537). `log()` is silent until this
 * instance's `initLogger` runs, so every file in the job imports from here; a second
 * `createJobLogger` call elsewhere would drop that file's log lines with no error.
 */

import { createJobLogger } from '@wxyc/observability/job-logger';

export const { initLogger, log, captureError, captureCounter, closeLogger } = createJobLogger({
  jobName: 'flowsheet-metadata-backfill',
  // Runs hourly, so its PostHog budget is 2 a run rather than 10 (BS#3409).
  errorBudget: 2,
});
