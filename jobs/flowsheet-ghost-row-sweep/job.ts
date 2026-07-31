/**
 * One-shot flowsheet + rotation ghost-row sweep (BS#1887).
 *
 * DRY-RUN IS THE DEFAULT. The container performs the full paged anti-join
 * scan against the configured keyspace source and reports per-table
 * scanned / ghost / sample counts with zero writes; pass `--execute` to
 * write. See jobs/flowsheet-ghost-row-sweep/README.md for the full seam
 * contract and why this issue never runs the tool against the real
 * tubafrenzy dump or production data — that's BS#1083.
 *
 *   docker run --rm --name flowsheet-ghost-row-sweep --env-file .env \
 *     <ECR-URI>/flowsheet-ghost-row-sweep:<tag>            # dry-run
 *   docker run --rm --name flowsheet-ghost-row-sweep --env-file .env \
 *     <ECR-URI>/flowsheet-ghost-row-sweep:<tag> --execute  # writes
 *
 * SIGTERM/SIGINT handling: the signal handler flips the orchestrator's
 * cooperative-stop flag; the run finishes its in-flight batch, emits a
 * structured `stopped` log line with per-target resume cursors, then falls
 * through to the `finally` arm. `process.on` (not `process.once`) is
 * deliberate — every SIGTERM/SIGINT just re-flips the already-true flag
 * (idempotent). Force-exit is SIGKILL (`docker kill`).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { FileKeyspaceSource } from './keyspace-source.js';
import { requestStop, resolveDryRun, runSweep } from './orchestrate.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'flowsheet-ghost-row-sweep';

const registerSignalHandlers = (): void => {
  const onSignal = (signal: NodeJS.Signals) => {
    log('warn', 'signal', `received ${signal}; requesting graceful stop`, { signal });
    requestStop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — see README.md for the LegacyKeyspaceSource seam.`);
  }
  return value;
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  registerSignalHandlers();
  try {
    const dryRun = resolveDryRun();
    const keyspaceSource = new FileKeyspaceSource(
      requireEnv('GHOST_SWEEP_FLOWSHEET_KEYSPACE_FILE'),
      requireEnv('GHOST_SWEEP_ROTATION_KEYSPACE_FILE')
    );
    log('info', 'init', `${JOB_NAME} initialized`, { dry_run: dryRun });
    const result = await runSweep({ dryRun, keyspaceSource });
    // runSweep catches its own loop exceptions to preserve the summary log
    // + span; propagate the failure (keyspace-load error, write error, or
    // retry exhaustion) through the exit code so a wrapping script's `$?`
    // check doesn't believe a partial run succeeded.
    if (result.failed) {
      process.exitCode = 1;
    }
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
