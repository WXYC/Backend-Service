/**
 * Entrypoint for jobs/rotation-release-id-backfill (BS#1029).
 *
 * One-shot ETL that pre-resolves Discogs release ids for active rotation
 * rows via LML, persisting to `rotation.discogs_release_id` with
 * `discogs_release_id_source = 'lml_offline_backfill'`. Restores the
 * planned tier-1/tier-2 read path for the dj-site rotation picker
 * (`getDiscogsReleaseIdByRotationId`) and unblocks BS#1030's revert of
 * the runtime LML cascade introduced in PR #987.
 *
 * Idempotent: the SELECT predicate is `discogs_release_id IS NULL` and the
 * WHERE guard on the UPDATE is the same — both rerun-safe and race-safe
 * against tubafrenzy pastes that may land mid-run.
 *
 * Invocation:
 *   docker run --rm --env-file .env <image>
 *
 * Required env: LIBRARY_METADATA_URL (LML host), LML_API_KEY (bearer),
 * DB_* (postgres connection).
 *
 * Optional env:
 *   DRY_RUN=true                              skip all UPDATEs; log planned writes
 *   BACKFILL_LML_MAX_CONCURRENT=N             default 1
 *   BACKFILL_LML_RATE_PER_MIN=N               default 20
 *   BACKFILL_LML_PER_CALL_TIMEOUT_MS=N        default 8000
 */

import { closeDatabaseConnection } from '@wxyc/database';

import { runBackfill } from './orchestrate.js';
import { loadCandidates } from './query.js';
import { lookupReleaseId } from './lml-fetch.js';
import { writeReleaseId } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'rotation-release-id-backfill';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const resolveDryRun = (): boolean => {
  const raw = process.env.DRY_RUN;
  return raw === 'true' || raw === '1';
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  const dryRun = resolveDryRun();
  try {
    requireLmlConfigured();
    log('info', 'init', `${JOB_NAME} initialized`, { dry_run: dryRun });
    const { totals } = await runBackfill({
      loadCandidates,
      lookup: lookupReleaseId,
      write: writeReleaseId,
      dryRun,
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
