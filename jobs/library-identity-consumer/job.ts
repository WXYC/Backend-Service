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

import { runConsumer, type Totals } from './orchestrate.js';
import { bulkResolveLibraries } from './lml-fetch.js';
import { writeSingleArtist, stampUnresolvedAttemptedAt } from './writer.js';
import {
  resolveBatchSize,
  resolveDryRun,
  resolveIncludeNullCanonical,
  resolvePartitionFilter,
  resolveStaleThreshold,
  resolveThrottleMs,
  resolveUnresolvedRetryDays,
} from './select.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'library-identity-consumer';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

/**
 * Project a run's totals onto the flat `consumer.*` span-attribute shape
 * (BS#1086: `rows_skipped.lml_untrusted_library_id` must mirror its sibling
 * `rows_skipped.lml_cardinality_mismatch` here — both are cardinality-class
 * skip buckets from `orchestrate.ts`, and only one being surfaced left the
 * other invisible to trace-explorer pivots). Extracted to a pure function so
 * the mapping is unit-testable without invoking Sentry or the DB.
 */
export const buildSpanAttributes = (totals: Totals): Record<string, number> => ({
  'consumer.scanned': totals.scanned,
  'consumer.rows_resolved': totals.rows_resolved,
  'consumer.rows_unresolved': totals.rows_unresolved,
  'consumer.rows_skipped.compilation': totals.rows_skipped.compilation,
  'consumer.rows_skipped.lml_error': totals.rows_skipped.lml_error,
  'consumer.rows_skipped.writer_error': totals.rows_skipped.writer_error,
  'consumer.rows_skipped.lml_cardinality_mismatch': totals.rows_skipped.lml_cardinality_mismatch,
  'consumer.rows_skipped.lml_untrusted_library_id': totals.rows_skipped.lml_untrusted_library_id,
  'consumer.source_rows_skipped_null_confidence': totals.source_rows_skipped_null_confidence,
  'consumer.lml_total_calls': totals.lml_total_calls,
  'consumer.lml_total_latency_ms': totals.lml_total_latency_ms,
});

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async (span) => {
    try {
      requireLmlConfigured();
      log('info', 'init', `${JOB_NAME} initialized`);

      const result = await runConsumer({
        bulkResolve: bulkResolveLibraries,
        writeSingleArtist,
        stampUnresolvedAttemptedAt,
        batchSize: resolveBatchSize(),
        throttleMs: resolveThrottleMs(),
        staleDays: resolveStaleThreshold(),
        includeNullCanonical: resolveIncludeNullCanonical(),
        unresolvedRetryDays: resolveUnresolvedRetryDays(),
        partition: resolvePartitionFilter(),
        dryRun: resolveDryRun(),
      });

      // Surface the run totals as span attributes so trace explorer can
      // pivot on them without scraping the JSON log.
      span.setAttributes(buildSpanAttributes(result.totals));
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

// Guard the auto-invoke so importing this module (e.g. to unit-test
// buildSpanAttributes) doesn't fire a stray run against a live DB/LML.
// Mirrors `jobs/album-level-backfill/job.ts`; Jest sets NODE_ENV='test' by
// default, production runs leave it unset.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
