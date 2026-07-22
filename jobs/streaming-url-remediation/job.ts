/**
 * One-shot streaming-URL host remediation (BS#1715).
 *
 * BS#1710 established that LML's `results[].artwork.spotify_url` sometimes
 * literally stores a NON-Spotify URL (Deezer, Apple, Bandcamp, Tidal) and BS
 * persisted it verbatim; iOS binds `spotify_url` to a hardwired green "Spotify"
 * button, so the mislabeled row opens the wrong provider. The ingestion guard
 * (#1712) and the read-time serve-seam guard (#1714) stop new pollution and
 * hide it from live reads, but BS persistence is fill-only so rows written
 * before the guards survive forever. This job is the durable data fix: it scans
 * `album_metadata` + `flowsheet` for rows whose stored host doesn't match the
 * column and rewrites each through the pure `computeStreamingUrlFix` arbiter —
 * relocating a real link that landed in the wrong slot and nulling an
 * unrecoverable foreign value so the read path can synthesize the
 * `open.spotify.com/search/…` fallback.
 *
 * NO LML: unlike the BS#1672 streaming-url-upgrade sibling (which re-queries
 * LML to upgrade search-shaped URLs), the correct value here is already in the
 * row or nowhere, so the fix is pure local host arbitration and NO
 * `LIBRARY_METADATA_URL` is required.
 *
 * DRY-RUN IS THE DEFAULT. The container performs the full paged scan and
 * reports scanned / changed counts plus a before→after sample with zero
 * writes; pass `--execute` to write. Run via deploy-manual.yml
 * (target=streaming-url-remediation, version=latest), then SSH to EC2 and:
 *
 *   docker run --rm --name streaming-url-remediation --env-file .env \
 *     <ECR-URI>/streaming-url-remediation:<tag>            # dry-run
 *   docker run --rm --name streaming-url-remediation --env-file .env \
 *     <ECR-URI>/streaming-url-remediation:<tag> --execute  # writes
 *
 * See jobs/streaming-url-remediation/README.md for the full run procedure
 * (off-peak window, sibling-cron pre-flight, `docker stop -t 600`, post-run
 * audit). Depends on #1712 (ingestion guard) merged + deployed so `--execute`
 * doesn't race a live writer re-polluting a row it just healed.
 *
 * SIGTERM/SIGINT handling: the signal handler flips the orchestrator's
 * cooperative-stop flag; the run finishes its in-flight batch, emits a
 * structured `stopped` log line with per-phase resume cursors, then falls
 * through to the `finally` arm. `process.on` (not `process.once`) is
 * deliberate — every SIGTERM/SIGINT just re-flips the already-true flag
 * (idempotent). Force-exit is SIGKILL (`docker kill`).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { requestStop, resolveDryRun, runRemediation } from './orchestrate.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'streaming-url-remediation';

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
    const result = await runRemediation({ dryRun });
    // runRemediation catches its own loop exceptions to preserve the summary
    // log + span; propagate the failure (write error or a failed post-run
    // verification) through the exit code so a wrapping script's `$?` check
    // doesn't believe a partial run succeeded.
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
