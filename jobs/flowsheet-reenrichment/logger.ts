/**
 * The one logger instance for flowsheet-reenrichment (BS#3399). `log()` is silent until this instance's
 * `initLogger` runs, so every file in the job imports from here; a second `createJobLogger`
 * call elsewhere would drop that file's log lines with no error.
 */

import { createJobLogger } from '@wxyc/observability/job-logger';

export const { initLogger, log, captureError, closeLogger, errorMessage } = createJobLogger({
  jobName: 'flowsheet-reenrichment',
});
