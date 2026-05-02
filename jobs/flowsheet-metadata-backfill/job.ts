/**
 * One-shot historical metadata drain (#638, A.1.a of #631).
 *
 * Iterates every `flowsheet` track row where the LML metadata enrichment
 * never ran (`metadata_attempt_at IS NULL`), calls LML's /lookup for each
 * one, and writes the 10-column metadata UPDATE plus the
 * `metadata_attempt_at = now()` stamp. Cross-run resumability is via the
 * WHERE filter alone — successful + no-match rows have the marker;
 * LML-throw rows don't and stay in the retry pool for the next sweep.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=flowsheet-metadata-backfill`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. The job runs
 * during a low-traffic window — LML's Discogs rate budget (50 req/min) is
 * the limiting factor across all parallel partitions, not the database.
 *
 * Recurring drift-repair flip is tracked at #639 Phase 2; that change
 * drops `"job-type": "one-shot"` from package.json and adds the EC2
 * cron entry. The orchestrator + enrich.ts shape is the same in both
 * modes — only the cadence changes.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';
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
    await runBackfill({ lookup: lookupMetadata, enrich: applyEnrichment });
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
