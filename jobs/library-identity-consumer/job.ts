/**
 * Entry point for the library-identity-consumer job (BS#802, extended by
 * BS#1991 / #801 S2 for `kind: 'compilation'`).
 *
 * Post-#800 architecture: Backend is thin writer; LML is sole composer of
 * cross-cache identity. The job calls LML's
 * `POST /api/v1/identity/bulk-resolve-libraries` for each batch of
 * libraries needing identity refresh and UPSERTs the verdicts into
 * `library_identity` + `library_identity_source` atomically; `kind:
 * 'compilation'` results whose per-track matcher ran land in
 * `compilation_track_artist` instead (see `writer.ts:writeCompilationTracks`).
 *
 * BS#1991 AC: the job runs as TWO sequential `runConsumer` drains — `va`
 * (small pages; `include_tracks` payloads can be large, S0/#1989 measured
 * p99 483 credits/release) and `non_va` (full width) — rather than one. Both
 * cohorts are classified locally (`select.ts`'s `VA_COHORT_CONDITION`) so
 * LML never has to gate the payload per input. `RECHECK=true` instead runs a
 * single on-demand `va`-cohort drain that re-visits every previously
 * attempted row regardless of the retry-day TTL — for picking up matcher
 * improvements after a deliberate re-run.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=library-identity-consumer`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. The job is
 * resumable and idempotent — rerunning is safe via UPSERT, and the SELECT
 * predicate re-picks rows whose batch failed.
 *
 * DRY_RUN: set `DRY_RUN=true` to call LML without writing. Each drain emits
 * its own JSON object on stdout with the locked schema; see README.md.
 */

import * as Sentry from '@sentry/node';

import { closeDatabaseConnection } from '@wxyc/database';

import { runConsumer, type Totals } from './orchestrate.js';
import { bulkResolveLibraries } from './lml-fetch.js';
import {
  writeSingleArtist,
  stampUnresolvedAttemptedAt,
  writeCompilationTracks,
  analyzeCompilationTrackArtist,
} from './writer.js';
import {
  resolveBatchSize,
  resolveDryRun,
  resolveIncludeNullCanonical,
  resolvePartitionFilter,
  resolveRecheck,
  resolveStaleThreshold,
  resolveThrottleMs,
  resolveUnresolvedRetryDays,
  resolveVaBatchSize,
} from './select.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'library-identity-consumer';

/**
 * Bulk-update-playbook gate for the post-run `ANALYZE compilation_track_artist`
 * (BS#1991): once per run, only when a drain actually changed rows — a
 * dry run writes nothing, and a no-op re-drain's `IS DISTINCT FROM` guard
 * can leave every drain at 0, where ANALYZE would re-stat an unchanged table.
 */
export const shouldAnalyzeCompilationTracks = (dryRun: boolean, ...writtenCounts: number[]): boolean =>
  !dryRun && writtenCounts.some((n) => n > 0);

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

/**
 * Project a run's totals onto the flat `<prefix>.*` span-attribute shape
 * (BS#1086: `rows_skipped.lml_untrusted_library_id` must mirror its sibling
 * `rows_skipped.lml_cardinality_mismatch` here — both are cardinality-class
 * skip buckets from `orchestrate.ts`, and only one being surfaced left the
 * other invisible to trace-explorer pivots). Extracted to a pure function so
 * the mapping is unit-testable without invoking Sentry or the DB.
 *
 * `prefix` defaults to `consumer` (the pre-BS#1991 single-drain shape);
 * `main()` below calls it once per drain with `consumer.va` / `consumer.non_va`
 * so both cohorts' totals land as distinct span attributes on the one run
 * span rather than one overwriting the other.
 */
export const buildSpanAttributes = (totals: Totals, prefix = 'consumer'): Record<string, number> => ({
  [`${prefix}.scanned`]: totals.scanned,
  [`${prefix}.rows_resolved`]: totals.rows_resolved,
  [`${prefix}.rows_resolved_compilation`]: totals.rows_resolved_compilation,
  [`${prefix}.rows_unresolved`]: totals.rows_unresolved,
  [`${prefix}.rows_skipped.compilation`]: totals.rows_skipped.compilation,
  [`${prefix}.rows_skipped.lml_error`]: totals.rows_skipped.lml_error,
  [`${prefix}.rows_skipped.writer_error`]: totals.rows_skipped.writer_error,
  [`${prefix}.rows_skipped.lml_cardinality_mismatch`]: totals.rows_skipped.lml_cardinality_mismatch,
  [`${prefix}.rows_skipped.lml_untrusted_library_id`]: totals.rows_skipped.lml_untrusted_library_id,
  [`${prefix}.source_rows_skipped_null_confidence`]: totals.source_rows_skipped_null_confidence,
  [`${prefix}.compilation_track_rows_written`]: totals.compilation_track_rows_written,
  [`${prefix}.compilation_track_rows_skipped_unchanged`]: totals.compilation_track_rows_skipped_unchanged,
  [`${prefix}.compilation_track_rows_skipped_librarian`]: totals.compilation_track_rows_skipped_librarian,
  [`${prefix}.compilation_track_rows_skipped_no_cta_match`]: totals.compilation_track_rows_skipped_no_cta_match,
  [`${prefix}.compilation_track_rows_skipped_no_catalog_artist`]:
    totals.compilation_track_rows_skipped_no_catalog_artist,
  [`${prefix}.compilation_track_position_rows_written`]: totals.compilation_track_position_rows_written,
  [`${prefix}.compilation_track_position_rows_skipped_ambiguous`]:
    totals.compilation_track_position_rows_skipped_ambiguous,
  [`${prefix}.lml_total_calls`]: totals.lml_total_calls,
  [`${prefix}.lml_total_latency_ms`]: totals.lml_total_latency_ms,
});

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async (span) => {
    try {
      requireLmlConfigured();
      log('info', 'init', `${JOB_NAME} initialized`);

      const throttleMs = resolveThrottleMs();
      const staleDays = resolveStaleThreshold();
      const partition = resolvePartitionFilter();
      const dryRun = resolveDryRun();

      if (resolveRecheck()) {
        const result = await runConsumer({
          bulkResolve: bulkResolveLibraries,
          writeSingleArtist,
          writeCompilationTracks,
          stampUnresolvedAttemptedAt,
          batchSize: resolveVaBatchSize(),
          throttleMs,
          staleDays,
          partition,
          dryRun,
          cohort: 'va',
          recheck: true,
        });
        span.setAttributes(buildSpanAttributes(result.totals, 'consumer.recheck'));
        if (shouldAnalyzeCompilationTracks(dryRun, result.totals.compilation_track_rows_written)) {
          await analyzeCompilationTrackArtist();
        }
        return;
      }

      const includeNullCanonical = resolveIncludeNullCanonical();
      const unresolvedRetryDays = resolveUnresolvedRetryDays();

      // BS#1991: sequential, not parallel — the two drains share this
      // container's LML pacing budget (@wxyc/lml-client conventions), and
      // the va cohort is normally a small fraction of the scan.
      const vaResult = await runConsumer({
        bulkResolve: bulkResolveLibraries,
        writeSingleArtist,
        writeCompilationTracks,
        stampUnresolvedAttemptedAt,
        batchSize: resolveVaBatchSize(),
        throttleMs,
        staleDays,
        partition,
        dryRun,
        includeNullCanonical,
        unresolvedRetryDays,
        cohort: 'va',
      });
      span.setAttributes(buildSpanAttributes(vaResult.totals, 'consumer.va'));

      const nonVaResult = await runConsumer({
        bulkResolve: bulkResolveLibraries,
        writeSingleArtist,
        writeCompilationTracks,
        stampUnresolvedAttemptedAt,
        batchSize: resolveBatchSize(),
        throttleMs,
        staleDays,
        partition,
        dryRun,
        includeNullCanonical,
        unresolvedRetryDays,
        cohort: 'non_va',
      });
      span.setAttributes(buildSpanAttributes(nonVaResult.totals, 'consumer.non_va'));

      if (
        shouldAnalyzeCompilationTracks(
          dryRun,
          vaResult.totals.compilation_track_rows_written,
          nonVaResult.totals.compilation_track_rows_written
        )
      ) {
        await analyzeCompilationTrackArtist();
      }
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
