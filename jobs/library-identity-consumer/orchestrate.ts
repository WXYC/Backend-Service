/**
 * Orchestrator for the library-identity-consumer job (BS#802).
 *
 * Post-#800 architecture: Backend is the thin writer; LML is sole composer
 * of cross-cache identity. The orchestrator:
 *
 *   1. SELECTs libraries needing identity refresh — the predicate lives in
 *      select.ts:loadBatch. Post-#1144 it gates canonicalized rows behind a
 *      freshness check (no `library_identity` row yet, OR the existing one is
 *      stale); BS#974's `INCLUDE_NULL_CANONICAL` flag (default off) expands it
 *      to also cover NULL-`canonical_entity_id` rows, with the
 *      `library.unresolved_attempted_at` no-match marker preventing a hot-loop.
 *   2. POSTs each batch (≤ 500 inputs, LML caps at 1000) to LML's
 *      `/api/v1/identity/bulk-resolve-libraries`.
 *   3. For each `BulkResolveResult`:
 *        - `kind: 'single_artist'` → atomic write via `writeSingleArtist`,
 *          counted as `rows_resolved`.
 *        - `kind: 'unresolved'` → counted as `rows_unresolved`, no write.
 *        - `kind: 'compilation'` → counted as `rows_skipped { compilation }`,
 *          deferred to BS#801.
 *   4. On per-batch LML error: the entire batch is counted as
 *      `rows_skipped { lml_error: <count> }`; the loop continues. Because
 *      the SELECT predicate keys off live data (a successful write moves a
 *      row out of the "stale" bucket), retry on the next run is free.
 *
 * Sentry metrics are accumulated and emitted both as JSON log fields and
 * as tags on the top-level run span.
 *
 * DRY_RUN: when set (locked truthy `true`/`1`/`TRUE`), the loop still calls
 * LML so resolve/unresolved/error counts are honest, but suppresses every
 * DB write. Emits a single JSON object on stdout with the locked schema
 * documented in README.md.
 *
 * `bulkResolve` and `writer` are injected so unit tests can drive the
 * orchestrator without exercising the network or the database. Production
 * wires them to `lml-fetch.ts:bulkResolveLibraries` and
 * `writer.ts:writeSingleArtist`.
 */

import type { SQL } from 'drizzle-orm';

import { loadBatch, type LibraryRow } from './select.js';
import type { BulkResolveInput, BulkResolveResponse, BulkResolveResult } from './lml-types.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'library-identity-consumer';

export type BulkResolveFn = (inputs: BulkResolveInput[]) => Promise<BulkResolveResponse>;

export type WriteSingleArtistFn = (
  result: Extract<BulkResolveResult, { kind: 'single_artist' }>
) => Promise<{ source_rows_written: number; source_rows_skipped_null_confidence: number }>;

/**
 * BS#974: stamps the `library.unresolved_attempted_at` no-match marker on a
 * batch's `unresolved` + `compilation` library_ids so a manual re-run doesn't
 * re-burn LML on them within `UNRESOLVED_RETRY_DAYS`. Injected (like
 * `bulkResolve`/`writeSingleArtist`) so unit tests can observe the stamped set
 * without a DB. Production wires it to `writer.ts:stampUnresolvedAttemptedAt`.
 */
export type StampUnresolvedFn = (libraryIds: number[]) => Promise<void>;

/**
 * Aggregate counters. The unit is library_ids except where noted.
 *
 * - `scanned`, `rows_resolved`, `rows_unresolved`, and every `rows_skipped.*`
 *   bucket count *library_ids* (one library_id contributes to exactly one of
 *   resolved / unresolved / one skip bucket): `scanned == rows_resolved +
 *   rows_unresolved + sum(rows_skipped.values())`.
 * - `source_rows_skipped_null_confidence` counts *source rows*: provenance
 *   entries whose `confidence` was null and therefore couldn't satisfy the
 *   `library_identity_source.confidence BETWEEN 0 AND 1 NOT NULL`
 *   constraint. Lives outside `rows_skipped` so the library_id-level
 *   accounting stays clean — a resolved library_id can still contribute to
 *   this counter.
 */
export type Totals = {
  scanned: number;
  rows_resolved: number;
  rows_unresolved: number;
  rows_skipped: {
    compilation: number;
    lml_error: number;
    writer_error: number;
    lml_cardinality_mismatch: number;
    lml_untrusted_library_id: number;
  };
  source_rows_skipped_null_confidence: number;
  lml_total_calls: number;
  lml_total_latency_ms: number;
};

export type DryRunReport = {
  scanned: number;
  lml_total_calls: number;
  lml_total_latency_ms: number;
  would_resolve: number;
  would_unresolved: number;
  would_skip: {
    compilation: number;
    lml_error: number;
    lml_cardinality_mismatch: number;
    lml_untrusted_library_id: number;
  };
  source_rows_skipped_null_confidence: number;
};

export type RunResult = {
  totals: Totals;
  dryRunReport: DryRunReport | null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const emptyTotals = (): Totals => ({
  scanned: 0,
  rows_resolved: 0,
  rows_unresolved: 0,
  rows_skipped: {
    compilation: 0,
    lml_error: 0,
    writer_error: 0,
    lml_cardinality_mismatch: 0,
    lml_untrusted_library_id: 0,
  },
  source_rows_skipped_null_confidence: 0,
  lml_total_calls: 0,
  lml_total_latency_ms: 0,
});

const formatTotals = (t: Totals): string =>
  `scanned=${t.scanned} resolved=${t.rows_resolved} unresolved=${t.rows_unresolved} ` +
  `skipped.compilation=${t.rows_skipped.compilation} skipped.lml_error=${t.rows_skipped.lml_error} ` +
  `skipped.writer_error=${t.rows_skipped.writer_error} ` +
  `skipped.lml_cardinality_mismatch=${t.rows_skipped.lml_cardinality_mismatch} ` +
  `skipped.lml_untrusted_library_id=${t.rows_skipped.lml_untrusted_library_id} ` +
  `source_rows_skipped_null_confidence=${t.source_rows_skipped_null_confidence} ` +
  `lml_calls=${t.lml_total_calls} lml_latency_ms=${t.lml_total_latency_ms}`;

export const runConsumer = async (opts: {
  bulkResolve: BulkResolveFn;
  writeSingleArtist: WriteSingleArtistFn;
  batchSize: number;
  throttleMs: number;
  staleDays: number;
  partition: { sqlFragment: SQL | null; description: string };
  dryRun: boolean;
  onDryRunReport?: (report: DryRunReport) => void;
  // BS#974 — optional so existing callers/tests that predate the NULL-canonical
  // expansion keep compiling. Defaults reproduce the #1144 behavior exactly.
  includeNullCanonical?: boolean;
  unresolvedRetryDays?: number;
  stampUnresolvedAttemptedAt?: StampUnresolvedFn;
}): Promise<RunResult> => {
  const includeNullCanonical = opts.includeNullCanonical ?? false;
  const unresolvedRetryDays = opts.unresolvedRetryDays ?? 30;

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: opts.batchSize,
    throttle_ms: opts.throttleMs,
    stale_days: opts.staleDays,
    include_null_canonical: includeNullCanonical,
    unresolved_retry_days: unresolvedRetryDays,
    partition: opts.partition.description,
    dry_run: opts.dryRun,
  });

  const totals = emptyTotals();
  let lastId = 0;
  let batchIndex = 0;

  while (true) {
    const rows: LibraryRow[] = await loadBatch(
      lastId,
      opts.batchSize,
      opts.partition.sqlFragment,
      opts.staleDays,
      includeNullCanonical,
      unresolvedRetryDays
    );
    if (rows.length === 0) break;
    batchIndex += 1;

    const inputs: BulkResolveInput[] = rows.map((r) => ({
      library_id: r.id,
      artist_name: r.artist_name,
      album_title: r.album_title,
    }));

    let response: BulkResolveResponse;
    const lmlStart = Date.now();
    try {
      response = await opts.bulkResolve(inputs);
      totals.lml_total_calls += 1;
      totals.lml_total_latency_ms += Date.now() - lmlStart;
    } catch (error) {
      totals.lml_total_calls += 1;
      totals.lml_total_latency_ms += Date.now() - lmlStart;
      log('warn', 'lml_error', `LML bulk-resolve failed for batch ${batchIndex}`, {
        batch_index: batchIndex,
        batch_size: rows.length,
        error_message: (error as Error).message,
      });
      captureError(error, 'lml_error', { batch_index: batchIndex, batch_size: rows.length });
      // Count every row in this batch as skipped (lml_error). The next run
      // will re-pick them up via the SELECT predicate.
      totals.scanned += rows.length;
      totals.rows_skipped.lml_error += rows.length;
      lastId = rows[rows.length - 1].id;
      if (opts.throttleMs > 0) await sleep(opts.throttleMs);
      continue;
    }

    // Defensive cardinality check. api.yaml v1.2.0 says LML preserves order
    // and returns one result per input, but doesn't guarantee 1:1 cardinality
    // contractually. Without this check, a short response would silently
    // under-report `scanned`.
    if (response.results.length !== rows.length) {
      const missing = rows.length - response.results.length;
      log(
        'warn',
        'lml_cardinality_mismatch',
        `LML returned ${response.results.length} results for ${rows.length} inputs in batch ${batchIndex}`,
        {
          batch_index: batchIndex,
          inputs: rows.length,
          results: response.results.length,
          missing,
        }
      );
      captureError(
        new Error(`LML cardinality mismatch: ${response.results.length} of ${rows.length} inputs returned`),
        'lml_cardinality_mismatch',
        { batch_index: batchIndex, inputs: rows.length, results: response.results.length }
      );
      // Count the missing inputs as a distinct skip bucket so the operator
      // sees this is upstream-protocol drift rather than a transport error.
      if (missing > 0) {
        totals.scanned += missing;
        totals.rows_skipped.lml_cardinality_mismatch += missing;
      }
    }

    // Per-row membership validation. The cardinality check above only
    // catches a short response; it says nothing about whether the
    // `library_id` on each individual result actually belongs to this
    // batch's inputs (a duplicated id compensating for a dropped one keeps
    // response.results.length === rows.length and would sail through the
    // length-only check). Build the batch's input-id set once and validate
    // every result's `library_id` against it, tracking already-seen ids so
    // a duplicate within the same batch is also flagged rather than
    // silently double-written.
    const inputIds = new Set(rows.map((r) => r.id));
    const consumedIds = new Set<number>();
    // BS#974: library_ids LML responded on with a definitive non-resolution
    // (`unresolved`/`compilation`). Stamped after the loop (flag-on, non-dry-
    // run) so a manual re-run doesn't re-burn LML on them within the window.
    const noMatchLibraryIds: number[] = [];

    for (const result of response.results) {
      if (!inputIds.has(result.library_id) || consumedIds.has(result.library_id)) {
        totals.scanned += 1;
        totals.rows_skipped.lml_untrusted_library_id += 1;
        log(
          'warn',
          'lml_untrusted_library_id',
          `LML returned library_id=${result.library_id} not present (or already consumed) in batch ${batchIndex}'s input set`,
          {
            batch_index: batchIndex,
            library_id: result.library_id,
          }
        );
        captureError(
          new Error(`LML untrusted library_id: ${result.library_id} not in batch ${batchIndex}'s input set`),
          'lml_untrusted_library_id',
          { batch_index: batchIndex, library_id: result.library_id }
        );
        continue;
      }
      consumedIds.add(result.library_id);

      totals.scanned += 1;
      switch (result.kind) {
        case 'single_artist':
          if (opts.dryRun) {
            totals.rows_resolved += 1;
            break;
          }
          try {
            const outcome = await opts.writeSingleArtist(result);
            totals.rows_resolved += 1;
            totals.source_rows_skipped_null_confidence += outcome.source_rows_skipped_null_confidence;
          } catch (error) {
            log('warn', 'writer_error', `writer failed for library_id=${result.library_id}`, {
              library_id: result.library_id,
              error_message: (error as Error).message,
            });
            captureError(error, 'writer_error', { library_id: result.library_id });
            totals.rows_skipped.writer_error += 1;
          }
          break;
        case 'unresolved':
          totals.rows_unresolved += 1;
          noMatchLibraryIds.push(result.library_id);
          break;
        case 'compilation':
          // BS#801 will handle compilation results via library_track_*
          // tables. For BS#802 we count + skip.
          totals.rows_skipped.compilation += 1;
          noMatchLibraryIds.push(result.library_id);
          break;
      }
    }

    // BS#974: stamp the no-match marker so a subsequent manual re-run skips
    // these until `unresolvedRetryDays` elapse. Only under the flag (off = the
    // pre-#974 predicate never reads the marker) and never in dry-run. Stamp
    // failure is a best-effort miss (rows just re-attempt next run), not a
    // correctness fault — log + continue rather than abort the drain.
    if (includeNullCanonical && !opts.dryRun && opts.stampUnresolvedAttemptedAt && noMatchLibraryIds.length > 0) {
      try {
        await opts.stampUnresolvedAttemptedAt(noMatchLibraryIds);
      } catch (error) {
        log('warn', 'stamp_error', `failed to stamp unresolved_attempted_at for batch ${batchIndex}`, {
          batch_index: batchIndex,
          count: noMatchLibraryIds.length,
          error_message: (error as Error).message,
        });
        captureError(error, 'stamp_error', { batch_index: batchIndex, count: noMatchLibraryIds.length });
      }
    }

    lastId = rows[rows.length - 1].id;

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      last_id: lastId,
      ...totals,
    });

    if (opts.throttleMs > 0) await sleep(opts.throttleMs);
  }

  const dryRunReport: DryRunReport | null = opts.dryRun
    ? {
        scanned: totals.scanned,
        lml_total_calls: totals.lml_total_calls,
        lml_total_latency_ms: totals.lml_total_latency_ms,
        would_resolve: totals.rows_resolved,
        would_unresolved: totals.rows_unresolved,
        would_skip: {
          compilation: totals.rows_skipped.compilation,
          lml_error: totals.rows_skipped.lml_error,
          lml_cardinality_mismatch: totals.rows_skipped.lml_cardinality_mismatch,
          lml_untrusted_library_id: totals.rows_skipped.lml_untrusted_library_id,
        },
        // Source-row unit, not library_id — kept outside `would_skip` so the
        // library_id-level accounting stays clean.
        source_rows_skipped_null_confidence: totals.source_rows_skipped_null_confidence,
      }
    : null;

  if (dryRunReport) {
    process.stdout.write(JSON.stringify(dryRunReport) + '\n');
    if (opts.onDryRunReport) opts.onDryRunReport(dryRunReport);
  }

  log('info', 'finished', `${JOB_NAME} done. ${formatTotals(totals)}`, { ...totals });
  return { totals, dryRunReport };
};
