/**
 * One-shot V/A Apple-Music-URL remediation (BS#2000).
 *
 * Heals the rows BS persisted from LML's pre-#1139 V/A-blind Apple track
 * matcher, in two phases with different mechanisms (see orchestrate.ts for
 * why): flowsheet gets a real LML re-verify because a null there is terminal;
 * album_metadata is invalidated to `apple_music_status='unresolved'` so the
 * BS#1915 hourly re-ask sweep re-adjudicates it through the guarded matcher.
 * Flowsheet runs FIRST, because nulling album_metadata unmasks whatever
 * flowsheet holds for the same row.
 *
 * DRY-RUN IS THE DEFAULT, and a dry-run makes ZERO LML calls — it sizes the
 * candidate set and the distinct-triple count and writes nothing. Pass
 * `--execute` to write.
 *
 * HARD PRECONDITIONS (see the README):
 *   1. LML#1139's guard AND its track-cache purge are deployed. Re-verifying
 *      against the unguarded matcher re-persists the same wrong URLs; against
 *      a guarded matcher with an unpurged cache, the wrong URL comes straight
 *      back from L1.
 *   2. `LML_APPLE_MUSIC_RATE_PER_MIN` is rolled up and CONFIRMED live. At the
 *      default, LML#904 measured ~56% of Apple probes nulling out on LML's own
 *      throttle, which would make this job's no-match verdicts untrustworthy.
 *      The run's rescue-rate detector is the backstop, not the gate.
 *
 * Run via deploy-manual.yml (target=va-apple-music-url-remediation), then SSH
 * to EC2 and:
 *
 *   docker run --rm --name va-apple-music-url-remediation --env-file .env \
 *     <ECR-URI>/va-apple-music-url-remediation:<tag>            # dry-run
 *   docker run --rm --name va-apple-music-url-remediation --env-file .env \
 *     <ECR-URI>/va-apple-music-url-remediation:<tag> --execute  # writes
 *
 * SIGTERM/SIGINT flips the orchestrator's cooperative-stop flag; the in-flight
 * batch finishes and the summary carries the resume cursors. `process.on` (not
 * `once`) is deliberate — every signal just re-flips an already-true flag.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { requestStop, resolveDryRun, runRemediation } from './orchestrate.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'va-apple-music-url-remediation';

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
    // runRemediation catches its own loop exceptions to preserve the summary,
    // so propagate failure through the exit code — including the case where a
    // triple stayed indeterminate, which means the AC ("no candidate row
    // retains an unadjudicated pre-#1139 URL") is NOT yet satisfied.
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
