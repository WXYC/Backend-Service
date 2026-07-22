/**
 * One-shot streaming-URL upgrade remediation (BS#1672).
 *
 * Backend-Service persisted LML's write-time streaming *search*-URL
 * fallbacks (`@wxyc/metadata` `synthesizeSearchUrls`) verbatim into
 * `spotify_url` / `bandcamp_url` and never re-queries, so a row that could
 * now resolve to a verified album link stays a search URL forever. With the
 * LML-side drains landed (LML#831 Spotify, LML#832 Bandcamp), a re-query
 * resolves many of them. This job re-queries LML for every `album_metadata`
 * / `flowsheet` row whose `spotify_url` OR `bandcamp_url` is search-shaped,
 * and overwrites ONLY the still-search-shaped columns (never a verified
 * link — the UPDATE's SQL LIKE guard enforces never-downgrade).
 *
 * DRY-RUN IS THE DEFAULT. The container performs the full paced LML
 * sweep and reports candidates / would-upgrade counts with zero writes;
 * pass `--execute` to write. Run via deploy-manual.yml
 * (target=streaming-url-upgrade, version=latest), then SSH to EC2 and:
 *
 *   docker run --rm --name streaming-url-upgrade --env-file .env \
 *     <ECR-URI>/streaming-url-upgrade:<tag>            # dry-run
 *   docker run --rm --name streaming-url-upgrade --env-file .env \
 *     <ECR-URI>/streaming-url-upgrade:<tag> --execute  # writes
 *
 * See jobs/streaming-url-upgrade/README.md for the full run procedure
 * (off-peak window, sibling-cron pre-flight, `docker stop -t 600`,
 * post-run audit).
 *
 * SIGTERM/SIGINT handling: the signal handler flips the orchestrator's
 * cooperative-stop flag; the run finishes its in-flight row, emits a
 * structured `stopped` log line with per-phase resume cursors, then falls
 * through to the `finally` arm. `process.on` (not `process.once`) is
 * deliberate — every SIGTERM/SIGINT just re-flips the already-true flag
 * (idempotent). Force-exit is SIGKILL (`docker kill`).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { requestStop, resolveDryRun, runUpgrade } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'streaming-url-upgrade';

/**
 * Fail-fast on missing LML configuration. Without this, every candidate's
 * lookup would throw at the client's `baseUrl()` and the orchestrator
 * would grind through the whole cohort emitting `lml_error` events.
 */
const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

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
    requireLmlConfigured();
    log('info', 'init', `${JOB_NAME} initialized`, { dry_run: dryRun });
    const result = await runUpgrade({
      lookup: lookupMetadata,
      dryRun,
    });
    // runUpgrade catches its own loop exceptions to preserve the summary
    // log + span; propagate the failure through the exit code so a
    // wrapping script's `$?` check doesn't believe a sustained-outage run
    // succeeded.
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
