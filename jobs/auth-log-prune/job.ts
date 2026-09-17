/**
 * One-shot-per-run cron (BS#2363, extended by BS#2536): delete
 * `station_signup_attempt` rows older than the 30-day audit retention
 * window, and `account_audit_event` rows older than
 * `ACCOUNT_AUDIT_RETENTION_DAYS` (default 730 — parent epic #2534 decision
 * 9). Thin lifecycle wrapper around the already-exported
 * `pruneSignupAttempts` (shared/authentication/src/station-passcode.ts) and
 * `pruneAccountAuditEvents` (shared/database/src/account-audit.ts) — this
 * file owns only logging + Sentry init and the DB pool/logger lifecycle,
 * mirroring `jobs/station-signup-review/job.ts`.
 *
 * The two prunes run under SEPARATE try/catch blocks, deliberately: a single
 * wrapper would let a `station_signup_attempt` failure silently skip the
 * `account_audit_event` prune forever (and vice versa). Either failure exits
 * 1; both are always attempted regardless of the other's outcome.
 *
 * No SIGTERM/SIGINT handling, no dry-run, no batching: each prune is a
 * single `DELETE ... WHERE <cutoff column> < cutoff` statement, not a paged
 * sweep.
 */
import { closeDatabaseConnection, pruneAccountAuditEvents, requirePositiveInt } from '@wxyc/database';
import { pruneSignupAttempts } from '@wxyc/authentication';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'auth-log-prune';

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  log('info', 'init', `${JOB_NAME} initialized`);

  let failed = false;

  try {
    const deletedCount = await pruneSignupAttempts();
    log('info', 'complete', 'station_signup_attempt prune complete', { deleted_count: deletedCount });
  } catch (error) {
    log('error', 'failed', 'station_signup_attempt prune failed', { error_message: errorMessage(error) });
    captureError(error, 'signup-attempt-prune-failed');
    failed = true;
  }

  try {
    const olderThanDays = requirePositiveInt(
      process.env.ACCOUNT_AUDIT_RETENTION_DAYS,
      'ACCOUNT_AUDIT_RETENTION_DAYS',
      730
    );
    const deletedCount = await pruneAccountAuditEvents({ olderThanDays });
    log('info', 'complete', 'account_audit_event prune complete', { deleted_count: deletedCount });
  } catch (error) {
    log('error', 'failed', 'account_audit_event prune failed', { error_message: errorMessage(error) });
    captureError(error, 'account-audit-prune-failed');
    failed = true;
  }

  if (failed) process.exitCode = 1;

  await closeDatabaseConnection();
  await closeLogger();
};

void main();
