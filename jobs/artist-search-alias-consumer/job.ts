/**
 * Entry point for the artist-search-alias-consumer job (BS#1266).
 *
 * Daily cron (default `15 4 * * *` UTC — 00:15 ET, off-peak). Consumes LML's
 * `POST /api/v1/artists/search-aliases/bulk` for each batch of WXYC artist
 * names that need an alias refresh, plus a shadow-ingest of
 * `library.alternate_artist_name`, and UPSERTs the composed variants into
 * the `artist_search_alias` cache (migration 0089).
 *
 * Run procedure:
 *   - Production: cron-registered via the BS deploy-base machinery
 *     (`cron-schedule` field in package.json).
 *   - Manual one-shot on EC2:
 *       docker run --rm --env-file .env <image> 2>&1 | tee log
 *   - DRY_RUN: set `DRY_RUN=true` to call LML without writing. Emits a
 *     single locked-schema JSON object on stdout (see README.md).
 *
 * Resumable + idempotent: every write is an UPSERT; the SELECT predicate
 * moves freshly-written rows out of the staleness bucket on the next run.
 * The text cursor advances by batch tail so an all-V/A batch cannot stall
 * the loop.
 */

import * as Sentry from '@sentry/node';

import { closeDatabaseConnection } from '@wxyc/database';

import { runConsumer } from './orchestrate.js';
import { fetchArtistSearchAliasesBulk } from './lml-fetch.js';
import { writeArtistVariants } from './writer.js';
import { fetchAlternateArtistNames } from './alt-name-source.js';
import {
  loadNameGroups,
  resolveBatchSize,
  resolveDryRun,
  resolvePartition,
  resolveStaleThreshold,
  resolveThrottleMs,
} from './select.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'artist-search-alias-consumer';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async () => {
    try {
      requireLmlConfigured();
      log('info', 'init', `${JOB_NAME} initialized`);

      const batchSize = resolveBatchSize();
      const throttleMs = resolveThrottleMs();
      const staleDays = resolveStaleThreshold();
      const partition = resolvePartition();
      const dryRun = resolveDryRun();

      const result = await runConsumer({
        loadNameGroups: (cursor: string) => loadNameGroups(cursor, batchSize, partition, staleDays),
        fetchBulk: fetchArtistSearchAliasesBulk,
        fetchAlts: fetchAlternateArtistNames,
        writeArtistVariants,
        batchSize,
        throttleMs,
        staleDays,
        partition,
        dryRun,
      });

      // Surface run totals as a CHILD span whose numeric attributes are set
      // at creation time. Per BS#1081 (and MEMORY's
      // `feedback_sentry_attribute_typing_trap`), numeric values passed via
      // `setAttribute(name, number)` AFTER the span has already started get
      // indexed as strings, which breaks avg/p50/p95/sum aggregation on
      // Sentry dashboards. Passing them via the `attributes` field of the
      // startSpan options indexes them as numbers.
      Sentry.startSpan(
        {
          name: `${JOB_NAME}.run.totals`,
          attributes: {
            'consumer.names_scanned': result.totals.names_scanned,
            'consumer.names_resolved': result.totals.names_resolved,
            'consumer.names_missing': result.totals.names_missing,
            'consumer.names_unaccounted': result.totals.names_unaccounted,
            'consumer.fanout_writes': result.totals.fanout_writes,
            'consumer.source_rows_written': result.totals.source_rows_written,
            'consumer.writer_errors': result.totals.writer_errors,
            'consumer.lml_total_calls': result.totals.lml_total_calls,
            'consumer.lml_total_latency_ms': result.totals.lml_total_latency_ms,
          },
        },
        () => {
          /* attributes set at creation; nothing else to do */
        }
      );
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
