/**
 * One-shot-per-run cron (BS#2363): delete `station_signup_attempt` rows older
 * than the 30-day audit retention window. Thin lifecycle wrapper around the
 * already-exported `pruneSignupAttempts` (shared/authentication/src/station-passcode.ts)
 * — this file owns only logging + Sentry init and the DB pool/logger
 * lifecycle, mirroring `jobs/station-signup-review/job.ts`.
 *
 * No SIGTERM/SIGINT handling, no dry-run, no batching: this is a single
 * `DELETE ... WHERE attempted_at < cutoff` statement, not a paged sweep.
 */
import { closeDatabaseConnection } from '@wxyc/database';
import { pruneSignupAttempts } from '@wxyc/authentication';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'station-signup-attempt-prune';

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    log('info', 'init', `${JOB_NAME} initialized`);
    const deletedCount = await pruneSignupAttempts();
    log('info', 'complete', `${JOB_NAME} complete`, { deleted_count: deletedCount });
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
