/**
 * One-shot re-enrichment drain (BS#1433).
 *
 * Rescues ~11,965 flowsheet rows written as `enriched_no_match` before
 * LML#583 (merged 2026-06-16T17:53:53Z) closed the library-miss recall
 * gap. Set BACKFILL_CUTOFF_TS to the LML#583 merge timestamp.
 *
 * Run via deploy-manual.yml (target=flowsheet-reenrichment, version=latest),
 * then SSH to EC2 and:
 *
 *   docker run --rm --name flowsheet-reenrichment --env-file .env \
 *     -e BACKFILL_CUTOFF_TS='2026-06-16T17:53:53Z' \
 *     <ECR-URI>/flowsheet-reenrichment:<tag>
 *
 * See jobs/flowsheet-reenrichment/README.md for the full run procedure,
 * including the `docker stop -t 600` recommendation (default 10s grace
 * isn't enough for an in-flight batch to drain through LML).
 *
 * Blocked by #1011 (shared LML budget). Pre-flight: verify the sibling
 * flowsheet-metadata-backfill-cron container is Exited before launching.
 *
 * SIGTERM/SIGINT handling: the signal handler flips the orchestrator's
 * cooperative-stop flag; the run finishes its in-flight row (round 3:
 * between-row check, not between-batch), emits a structured `stopped`
 * log line, then falls through to the `finally` arm. A *second* SIGTERM
 * arriving before the run completes is allowed to terminate the process
 * via Node's default handler — this is intentional escape-hatch behavior
 * for operators who need to force-exit a wedged in-flight LML call. We
 * use `process.on` (not `process.once`) so any number of SIGTERMs flip
 * the flag idempotently; the override is the operator's responsibility.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runReenrichment, requestStop } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';
import { reenrichRow } from './enrich.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'flowsheet-reenrichment';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const requireCutoffConfigured = (): void => {
  if (!process.env.BACKFILL_CUTOFF_TS) {
    throw new Error('BACKFILL_CUTOFF_TS is not configured; set to the LML#583 merge timestamp (2026-06-16T17:53:53Z).');
  }
};

const registerSignalHandlers = (): void => {
  // `process.on` (not `process.once`): repeated SIGTERMs from `docker stop`
  // retries simply re-flip the (already-true) stop flag — idempotent. An
  // operator who *wants* a force-exit can attach a second handler or send
  // SIGKILL; we don't pretend to defend against intentional force-exit.
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
    requireLmlConfigured();
    requireCutoffConfigured();
    log('info', 'init', `${JOB_NAME} initialized`, { cutoff_ts: process.env.BACKFILL_CUTOFF_TS });
    await runReenrichment({
      lookup: lookupMetadata,
      enrich: reenrichRow,
    });
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
