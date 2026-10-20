/**
 * The one logger instance for album-reviews-etl (BS#3398). `log()` is silent until this instance's
 * `initLogger` runs, so every file in the job imports from here; a second `createJobLogger`
 * call elsewhere would drop that file's log lines with no error.
 */

import { createJobLogger } from '@wxyc/observability/job-logger';

// `captureWarning` is the shared `captureMessage` (warning level, no fingerprint), not the shared
// `captureWarning`: this job's warnings have always grouped by message text in Sentry.
export const {
  initLogger,
  log,
  captureError,
  captureMessage: captureWarning,
  closeLogger,
} = createJobLogger({
  jobName: 'album-reviews-etl',
});
