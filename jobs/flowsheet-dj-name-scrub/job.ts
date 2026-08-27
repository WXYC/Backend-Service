/**
 * One-shot scrub of historical `flowsheet.dj_name` + marker `message` text
 * (BS#2281).
 *
 * DRY-RUN IS THE DEFAULT. The container performs the full three-pass paged
 * scan, computes every expected value with the canonical `@wxyc/database`
 * helpers, and reports per-pass scanned / changed / sample counts with zero
 * writes. Pass `--execute` to write.
 *
 *   docker run --rm --name flowsheet-dj-name-scrub --env-file .env \
 *     <ECR-URI>/flowsheet-dj-name-scrub:<tag>            # dry-run
 *   docker run --rm --name flowsheet-dj-name-scrub --env-file .env \
 *     <ECR-URI>/flowsheet-dj-name-scrub:<tag> --execute  # writes
 *
 * Read `jobs/flowsheet-dj-name-scrub/README.md` before the first live run —
 * in particular the SSE fan-out prerequisite, the conditional-GET watermark
 * side effect, and the two sibling jobs that would REVERSE this scrub.
 *
 * SIGTERM/SIGINT handling: the signal handler flips the orchestrator's
 * cooperative-stop flag; the run finishes its in-flight page, emits a
 * structured `stopped` log line carrying all three resume cursors, then falls
 * through to the `finally` arm. `process.on` (not `process.once`) is
 * deliberate — every subsequent signal just re-flips the already-true flag.
 * Force-exit is SIGKILL (`docker kill`).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { requestStop, resolveDryRun, runScrub } from './orchestrate.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'flowsheet-dj-name-scrub';

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
    const result = await runScrub({ dryRun });
    // runScrub catches its own loop exceptions to preserve the summary log +
    // span; propagate the failure (PII-index load error, write error, retry
    // exhaustion, cooperative-pause ceiling, or verification residue) through
    // the exit code so a wrapping script's `$?` check doesn't believe a
    // partial run succeeded.
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
