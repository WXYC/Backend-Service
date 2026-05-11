/**
 * Entry point for the library-identity-consumer job (BS#802).
 *
 * Post-#800 architecture: Backend is thin writer; LML is sole composer of
 * cross-cache identity. The job calls LML's
 * `POST /api/v1/identity/bulk-resolve-libraries` for each batch of
 * libraries needing identity refresh and UPSERTs the verdicts into
 * `library_identity` + `library_identity_source` atomically.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=library-identity-consumer`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. The job is
 * resumable and idempotent — rerunning is safe via UPSERT, and the SELECT
 * predicate re-picks rows whose batch failed.
 *
 * DRY_RUN: set `DRY_RUN=true` to call LML without writing. Emits a single
 * JSON object on stdout with the locked schema; see README.md.
 */

import * as Sentry from '@sentry/node';

import { closeDatabaseConnection } from '@wxyc/database';

import { runConsumer } from './orchestrate.js';
import { bulkResolveLibraries } from './lml-fetch.js';
import { writeSingleArtist } from './writer.js';
import {
  resolveBatchSize,
  resolveDryRun,
  resolvePartitionFilter,
  resolveStaleThreshold,
  resolveThrottleMs,
} from './select.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'library-identity-consumer';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async (span) => {
    try {
      requireLmlConfigured();
      log('info', 'init', `${JOB_NAME} initialized`);

      const result = await runConsumer({
        bulkResolve: bulkResolveLibraries,
        writeSingleArtist,
        batchSize: resolveBatchSize(),
        throttleMs: resolveThrottleMs(),
        staleDays: resolveStaleThreshold(),
        partition: resolvePartitionFilter(),
        dryRun: resolveDryRun(),
      });

      // Surface the run totals as span attributes so trace explorer can
      // pivot on them without scraping the JSON log.
      span.setAttributes({
        'consumer.scanned': result.totals.scanned,
        'consumer.rows_resolved': result.totals.rows_resolved,
        'consumer.rows_unresolved': result.totals.rows_unresolved,
        'consumer.rows_skipped.compilation': result.totals.rows_skipped.compilation,
        'consumer.rows_skipped.lml_error': result.totals.rows_skipped.lml_error,
        'consumer.rows_skipped.writer_error': result.totals.rows_skipped.writer_error,
        'consumer.lml_total_calls': result.totals.lml_total_calls,
        'consumer.lml_total_latency_ms': result.totals.lml_total_latency_ms,
      });
    } catch (error) {
      log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
      captureError(error, 'failed');
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection();
      await closeLogger();
    }
  });
};

void main();
