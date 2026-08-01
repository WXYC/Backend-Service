/**
 * Process entrypoint for the daily "no metadata match" digest. The run()
 * spine lives in `orchestrate.ts` (unit-tested there, without this file's
 * module-load `void main()` side effect); this file is the thin lifecycle
 * wrapper the Docker image invokes: init logging, run once, capture any
 * failure to Sentry exactly once, and always close the DB pool + logger.
 *
 * No SIGTERM/SIGINT handling needed -- unlike the paged sweeps, this job's
 * single query + single send complete well inside any reasonable timeout.
 */
import { closeDatabaseConnection } from '@wxyc/database';
import { JOB_NAME, run } from './orchestrate.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    log('info', 'init', `${JOB_NAME} initialized`);
    await run();
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: errorMessage(error) });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
