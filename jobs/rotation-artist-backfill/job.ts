/**
 * Entry point for the rotation-artist-backfill job (BS#1361).
 *
 * Daily cron (default `30 4 * * *` UTC — between artist-search-alias-consumer
 * at `15 4` and flowsheet-metadata-backfill at `0 6`). Two-tier loop:
 *
 *   for release_id in active_rotation_release_ids():
 *     release = GET /api/v1/discogs/release/{release_id}
 *     for artist_id in extract_phase1(release):
 *       GET /api/v1/discogs/artist/{artist_id}
 *
 * Both endpoints route through LML's fallthrough seam. The job's value is
 * that the second call now fires `_api_fetch` + write-back on any stub
 * row (LML#503), back-filling the artist cache for the small slice of
 * artists DJs actually see on flowsheets — without waiting for the next
 * monthly Discogs rebuild to land.
 *
 * Run procedure:
 *   - Production: registered via the BS deploy-base machinery
 *     (`cron-schedule` field in package.json picked up by
 *     scripts/resolve-cron-schedule.sh).
 *   - Manual one-shot on EC2:
 *       docker run --rm --env-file .env <image> 2>&1 | tee log
 *   - DRY_RUN: set `DRY_RUN=true` to enumerate the release + artist
 *     cardinality before any artist calls fire.
 *
 * Resumable + idempotent — see orchestrate.ts header.
 */

import * as Sentry from '@sentry/node';

import { closeDatabaseConnection } from '@wxyc/database';

import { DeployGuardError, enforceDeployGuard } from './deploy-guard.js';
import { runBackfill } from './orchestrate.js';
import { loadActiveRotationReleaseIds } from './query.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'rotation-artist-backfill';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
};

const envBool = (name: string): boolean => {
  const raw = process.env[name];
  return raw === '1' || raw === 'true' || raw === 'TRUE';
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async () => {
    try {
      requireLmlConfigured();
      log('info', 'init', `${JOB_NAME} initialized`);

      const guard = await enforceDeployGuard();
      log('info', 'deploy_guard', 'LML deploy gate passed', {
        commit_sha: guard.commit_sha,
        reason: guard.reason,
      });

      const concurrency = envInt('BACKFILL_LML_MAX_CONCURRENT', 3);
      const dryRun = envBool('DRY_RUN');

      const result = await runBackfill({
        loadReleaseIds: loadActiveRotationReleaseIds,
        concurrency,
        dryRun,
      });

      log('info', 'done', `${JOB_NAME} completed`, {
        ...result.totals,
        dry_run: dryRun,
      });
    } catch (error) {
      const step = error instanceof DeployGuardError ? 'deploy_guard' : 'failed';
      log('error', step, `${JOB_NAME} failed`, {
        error_message: (error as Error).message,
        error_name: (error as Error).name,
      });
      captureError(error, step);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection();
      await closeLogger();
    }
  });
};

void main();
