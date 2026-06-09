/**
 * Recurring metadata drift-repair (#641 Phase 1, A.3 of #631).
 *
 * Iterates every `flowsheet` track row where the LML metadata enrichment
 * never ran (`metadata_attempt_at IS NULL`), calls LML's /lookup for each
 * one, and writes the 10-column metadata UPDATE plus the
 * `metadata_attempt_at = now()` stamp. Cross-run resumability is via the
 * WHERE filter alone — successful + no-match rows have the marker;
 * LML-throw rows don't and stay in the retry pool for the next sweep.
 *
 * Run procedure: registered as a cron job in EC2's crontab via
 * `deploy-base.yml`'s job-type=cron pathway, schedule taken from
 * package.json's `cron-schedule` (`0 6 * * *` UTC = 02:00 ET overnight).
 * The container runs to completion or is killed by the next deploy / a
 * manual `docker rm -f flowsheet-metadata-backfill-cron`. The orchestrator's
 * cooperative pause (#735) defers each batch when DJ activity is observed
 * on `flowsheet`, so the job is safe to run in the always-on WXYC booth.
 *
 * Throughput is bounded upstream by LML's Discogs rate budget
 * (50 req/min global), not by the database — see #640 pilot data.
 * `PARTITION_COUNT=1` is the chosen rollout shape (#641 body): adding a
 * second partition saturated the same upstream gate without improving
 * combined throughput.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { lookupMetadata, getLookupCache } from './lml-fetch.js';
import { applyEnrichment } from './enrich.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'flowsheet-metadata-backfill';

/**
 * Fail-fast on missing LML configuration. Without this, every row's
 * `lookupMetadata` call would throw at `baseUrl()` and the orchestrator
 * would generate ~1.96M `lml_error` events before an operator notices.
 * Better to exit 1 immediately with a clear message.
 */
const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    requireLmlConfigured();
    log('info', 'init', `${JOB_NAME} initialized`);
    await runBackfill({
      lookup: lookupMetadata,
      enrich: applyEnrichment,
      cacheStats: () => getLookupCache().stats(),
    });
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
