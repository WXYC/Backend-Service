/**
 * Entrypoint for jobs/rotation-lml-identity-backfill (BS#1380).
 *
 * Daily-cron recurring drift-repair that resolves `rotation.lml_identity_id`
 * for active rows whose `discogs_release_id` is populated but
 * `lml_identity_id` is still NULL. Catches the two write paths that
 * legitimately produce that state:
 *
 *   1. `jobs/rotation-etl/job.ts` — rotation-etl writes only
 *      `discogs_release_id` from the tubafrenzy paste and never calls
 *      LML (its useful life is bounded by the tubafrenzy decommission
 *      window ~September 2026; investing in lml-client wiring there
 *      isn't worth the diff). The CASE clause in the UPSERT also
 *      explicitly clears `lml_identity_id` when a paste-correction
 *      changes the effective `discogs_release_id` — those clears land
 *      here for re-resolution too.
 *   2. `apps/backend/services/library.service.ts:addToRotation` —
 *      synchronous resolve at INSERT time; falls back to NULL on
 *      `LML_RESOLVE_TIMEOUT_MS` / 5xx / network failures so the music
 *      director isn't blocked on an LML outage. Those rows land here on
 *      the next daily tick.
 *
 * Modes:
 *   - default: run the resolve loop, write to PG, log totals
 *   - `DRY_RUN=true`: run the resolve loop, suppress all UPDATEs, surface
 *     planned writes via `resolved_dry`
 *   - `--report`: emit the resolvable-coverage SQL result and exit
 *     without running the resolve loop. Useful for ops queries against
 *     BS#1381's unblock condition (resolvable_coverage_pct >= 99.0
 *     steady-state).
 *
 * Idempotent: the SELECT predicate is `lml_identity_id IS NULL AND
 * discogs_release_id IS NOT NULL` and the writer guards on the same
 * predicate (plus `discogs_release_id` equality to defeat the
 * paste-correction race). Safe to re-run; safe to one-shot during
 * a deploy migration.
 *
 * One-shot invocation:
 *   docker run --rm --env-file .env $AWS_ECR_URI/rotation-lml-identity-backfill:latest
 *
 * Required env: LIBRARY_METADATA_URL (LML host), LML_API_KEY (bearer),
 * DB_* (postgres connection).
 *
 * Optional env:
 *   DRY_RUN=true                              skip all UPDATEs; log planned writes
 *   BACKFILL_LML_MAX_CONCURRENT=N             default 1
 *   BACKFILL_LML_RATE_PER_MIN=N               default 20
 *   BACKFILL_LML_RESOLVE_TIMEOUT_MS=N         default 8000
 *   LIVE_ACTIVITY_LOOKBACK_SECONDS=N          default 60; 0 disables cooperative pause
 *   LIVE_ACTIVITY_PAUSE_MS=N                  default 30000
 */

import { closeDatabaseConnection } from '@wxyc/database';

import { runBackfill } from './orchestrate.js';
import { loadCandidates, loadCoverageReport } from './query.js';
import { lookupIdentityId } from './lml-fetch.js';
import { writeIdentityId } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'rotation-lml-identity-backfill';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const resolveDryRun = (): boolean => {
  const raw = process.env.DRY_RUN;
  return raw === 'true' || raw === '1' || raw === 'TRUE';
};

const isReportMode = (): boolean => process.argv.slice(2).includes('--report');

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  if (isReportMode()) {
    try {
      const report = await loadCoverageReport();
      log('info', 'coverage_report', `${JOB_NAME} --report`, { ...report });
      process.stdout.write(JSON.stringify(report) + '\n');
    } catch (error) {
      log('error', 'failed', `${JOB_NAME} --report failed`, { error_message: (error as Error).message });
      captureError(error, 'failed');
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection();
      await closeLogger();
    }
    return;
  }

  const dryRun = resolveDryRun();
  try {
    requireLmlConfigured();
    log('info', 'init', `${JOB_NAME} initialized`, { dry_run: dryRun });
    const { totals } = await runBackfill({
      loadCandidates,
      lookup: lookupIdentityId,
      write: writeIdentityId,
      dryRun,
      onLivePause: () => {
        log('info', 'live_activity_pause', 'live flowsheet activity detected; pausing');
      },
    });
    log('info', 'finished', `${JOB_NAME} done`, { dry_run: dryRun, ...totals });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
