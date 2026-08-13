/**
 * One-shot flowsheet April-gap import (BS#2119): backfill the closed BS#351
 * residue — flowsheet entries tubafrenzy holds that Backend never received.
 * See orchestrate.ts for the full mechanism and jobs/flowsheet-april-gap-import/README.md
 * for the run procedure.
 *
 * DRY-RUN IS THE DEFAULT. The container fetches the date-window candidate
 * set, computes the missing-from-Backend cohort, and reports a per-show
 * breakdown with zero writes; pass `--execute` to write.
 *
 *   docker run --rm --name flowsheet-april-gap-import --env-file .env \
 *     <ECR-URI>/flowsheet-april-gap-import:<tag>            # dry-run
 *   docker run --rm --name flowsheet-april-gap-import --env-file .env \
 *     <ECR-URI>/flowsheet-april-gap-import:<tag> --execute  # writes
 *
 * SIGTERM/SIGINT handling: the signal handler flips the orchestrator's
 * cooperative-stop flag; the run finishes its in-flight batch, emits a
 * structured `stopped` log line, then falls through to the `finally` arm.
 * `process.on` (not `process.once`) is deliberate — every SIGTERM/SIGINT
 * just re-flips the already-true flag (idempotent). Force-exit is SIGKILL
 * (`docker kill`).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { closeLegacyConnection } from '../flowsheet-etl/fetch-legacy.js';
import { requestStop, resolveDryRun, runImport } from './orchestrate.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'flowsheet-april-gap-import';

const registerSignalHandlers = (): void => {
  const onSignal = (signal: NodeJS.Signals) => {
    log('warn', 'signal', `received ${signal}; requesting graceful stop`, { signal });
    requestStop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  registerSignalHandlers();
  try {
    const dryRun = resolveDryRun();
    log('info', 'init', `${JOB_NAME} initialized`, { dry_run: dryRun });
    const result = await runImport({ dryRun });
    // runImport catches its own errors to preserve the summary log + span;
    // propagate a refusal or failure through the exit code so a wrapping
    // script's `$?` check doesn't believe a refused/failed run succeeded.
    if (result.failed || result.refused) {
      process.exitCode = 1;
    }
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: errorMessage(error) });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    // fetch-legacy.ts instantiates MirrorSQL.instance() at module scope; a
    // job that doesn't close it will hang on exit (SSH connection keepalive).
    closeLegacyConnection();
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
