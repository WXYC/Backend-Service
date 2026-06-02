/**
 * Orchestrator for the artist-search-alias-consumer job (BS#1266).
 *
 * Loop body:
 *   1. `loadNameGroups(cursor, batchSize, partition, staleDays)` returns a
 *      page of `{artist_name, artist_ids[]}` groups that need an alias
 *      refresh.
 *   2. Filter out V/A names client-side (`isCompilationArtist`). Cursor
 *      advances by the batch tail (not the eligible set) so an all-V/A
 *      batch cannot stall the loop.
 *   3. `fetchBulk(names)` POSTs the eligible names to LML's
 *      `POST /api/v1/artists/search-aliases/bulk`. The response carries one
 *      `ArtistSearchAliasesResult` per resolved name plus a `missing[]`
 *      list of unresolved names; a thrown error counts every name in the
 *      batch as `names_missing` and the loop continues.
 *   4. `fetchAlts(allArtistIds)` reads `library.alternate_artist_name` for
 *      the union of artist_ids in the batch.
 *   5. For each `(group, lml_result)` pair: build the variant list
 *      (LML variants + alt variants), append `'wxyc_library_alt'` to
 *      `sources_present`, then `writeArtistVariants(artist_id, …)` once
 *      per artist_id in the group. `fanout_writes` increments per
 *      artist_id beyond the first.
 *
 * DRY_RUN: still calls LML so resolved/missing/source counts are honest,
 * but suppresses every DB write. Emits a single locked-schema JSON object
 * on stdout (consumed by the deploy runbook's verification step).
 *
 * Dependencies are injected so unit tests can drive the orchestrator
 * without touching PG or the network. Production wires them via job.ts.
 */

import type { ArtistSearchAliasesBulkResponse, ArtistSearchAliasVariant } from './lml-types.js';
import type { NameGroup, Partition } from './select.js';
import { captureError, log } from './logger.js';
import { isCompilationArtist } from './compilation.js';

const JOB_NAME = 'artist-search-alias-consumer';
const WXYC_LIBRARY_ALT_CONFIDENCE = 0.85;

export type LoadNameGroupsFn = (cursor: string) => Promise<NameGroup[]>;
export type FetchBulkFn = (names: string[]) => Promise<ArtistSearchAliasesBulkResponse>;
export type FetchAltsFn = (artistIds: number[]) => Promise<Map<number, string[]>>;
export type WriteArtistVariantsFn = (
  artist_id: number,
  variants: ArtistSearchAliasVariant[],
  sourcesPresent: string[]
) => Promise<{ variants_written: number }>;

export type Totals = {
  names_scanned: number;
  names_resolved: number;
  names_missing: number;
  /**
   * Names that LML neither resolved nor flagged as missing — i.e., a
   * cardinality drift in LML's response. Should always be 0 in steady
   * state; a non-zero value points at upstream API drift and warrants
   * investigation (also Sentry-captured under `cardinality_drift` step).
   */
  names_unaccounted: number;
  fanout_writes: number;
  source_rows_written: number;
  /**
   * Per-artist writer failures (caught + Sentry-captured). Surfaced on the
   * top-level run span as `consumer.writer_errors` so the operator can
   * pivot on it without scraping logs; `source_rows_written` under-counts
   * by exactly this number when non-zero.
   */
  writer_errors: number;
  would_write_rows: number;
  lml_total_calls: number;
  lml_total_latency_ms: number;
};

export type DryRunReport = {
  names_scanned: number;
  would_resolve: number;
  would_missing: number;
  would_write_rows: number;
  lml_total_calls: number;
  lml_total_latency_ms: number;
};

export type RunResult = {
  totals: Totals;
  dryRunReport: DryRunReport | null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const emptyTotals = (): Totals => ({
  names_scanned: 0,
  names_resolved: 0,
  names_missing: 0,
  names_unaccounted: 0,
  fanout_writes: 0,
  source_rows_written: 0,
  writer_errors: 0,
  would_write_rows: 0,
  lml_total_calls: 0,
  lml_total_latency_ms: 0,
});

const buildAltVariants = (alts: string[]): ArtistSearchAliasVariant[] =>
  alts.map((variant) => ({
    source: 'wxyc_library_alt' as const,
    variant,
    method: 'alt_curated' as const,
    confidence: WXYC_LIBRARY_ALT_CONFIDENCE,
    related_artist_id: null,
    external_subject_id: null,
    external_object_id: null,
    active: null,
  }));

export const runConsumer = async (opts: {
  loadNameGroups: LoadNameGroupsFn;
  fetchBulk: FetchBulkFn;
  fetchAlts: FetchAltsFn;
  writeArtistVariants: WriteArtistVariantsFn;
  batchSize: number;
  throttleMs: number;
  staleDays: number;
  partition: Partition;
  dryRun: boolean;
}): Promise<RunResult> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: opts.batchSize,
    throttle_ms: opts.throttleMs,
    stale_days: opts.staleDays,
    partition: opts.partition.description,
    dry_run: opts.dryRun,
  });

  const totals = emptyTotals();
  let cursor = '';
  let batchIndex = 0;

  while (true) {
    const batch = await opts.loadNameGroups(cursor);
    if (batch.length === 0) break;
    batchIndex += 1;

    // Advance cursor by the BATCH TAIL, not by the eligible set, so an
    // all-V/A batch cannot get stuck re-loading the same range forever.
    cursor = batch[batch.length - 1].artist_name;

    const eligible = batch.filter((g) => !isCompilationArtist(g.artist_name));
    if (eligible.length === 0) {
      if (opts.throttleMs > 0) await sleep(opts.throttleMs);
      continue;
    }

    const names = eligible.map((g) => g.artist_name);
    let lmlResponse: ArtistSearchAliasesBulkResponse;
    const lmlStart = Date.now();
    try {
      lmlResponse = await opts.fetchBulk(names);
      totals.lml_total_calls += 1;
      totals.lml_total_latency_ms += Date.now() - lmlStart;
    } catch (error) {
      totals.lml_total_calls += 1;
      totals.lml_total_latency_ms += Date.now() - lmlStart;
      log('warn', 'lml_error', `LML artist-search-aliases failed for batch ${batchIndex}`, {
        batch_index: batchIndex,
        batch_size: eligible.length,
        error_message: (error as Error).message,
      });
      captureError(error, 'lml_error', { batch_index: batchIndex, batch_size: eligible.length });
      totals.names_scanned += eligible.length;
      totals.names_missing += eligible.length;
      if (opts.throttleMs > 0) await sleep(opts.throttleMs);
      continue;
    }

    // Index LML's response by name for O(1) lookup inside the loop body.
    const lmlByName = new Map<string, (typeof lmlResponse.artists)[number]>();
    for (const r of lmlResponse.artists) lmlByName.set(r.name, r);
    const lmlMissing = new Set<string>(lmlResponse.missing);

    const allArtistIds = eligible.flatMap((g) => g.artist_ids);
    const altsByArtist = await opts.fetchAlts(allArtistIds);

    // Collect cardinality-drift names within the batch, then emit ONE
    // Sentry event for the whole batch at the end of the loop body.
    // Per-name captureError would flood Sentry under wholesale upstream
    // drift (a 500-name batch × N batches = tens of thousands of events
    // per nightly run for one upstream incident). Mirrors the aggregate-
    // per-batch pattern in library-identity-consumer/orchestrate.ts.
    const unaccountedInBatch: string[] = [];

    for (const group of eligible) {
      totals.names_scanned += 1;
      const lmlResult = lmlByName.get(group.artist_name);
      const isMissing = !lmlResult && lmlMissing.has(group.artist_name);
      if (lmlResult) totals.names_resolved += 1;
      else if (isMissing) totals.names_missing += 1;
      else {
        // Cardinality drift from LML: the name was sent, but neither
        // `artists[]` nor `missing[]` mentions it. Bucket separately so
        // Sentry's `consumer.names_unaccounted` surfaces upstream API
        // drift rather than burying it inside `names_missing`.
        totals.names_unaccounted += 1;
        unaccountedInBatch.push(group.artist_name);
      }

      const lmlVariants = lmlResult?.variants ?? [];
      // `sources_present` records which legs the composer ran. We always
      // append `wxyc_library_alt` because the orchestrator just ran the
      // local SELECT — the leg is unambiguously "attempted" regardless of
      // whether it returned anything.
      const sourcesPresent: string[] = [...(lmlResult?.sources_present ?? []), 'wxyc_library_alt'];

      // Fan variants out across every artist_id in the group.
      const isFanoutGroup = group.artist_ids.length > 1;
      for (const artist_id of group.artist_ids) {
        // `fanout_writes` counts every write to a group with duplicate
        // artist_names — the Sentry signal for tubafrenzy data-quality
        // regressions (sudden surge of duplicate-named artists).
        if (isFanoutGroup) totals.fanout_writes += 1;
        const altNames = altsByArtist.get(artist_id) ?? [];
        const altVariants = buildAltVariants(altNames);
        const allVariants = [...lmlVariants, ...altVariants];

        if (opts.dryRun) {
          totals.would_write_rows += allVariants.length;
          continue;
        }

        try {
          const outcome = await opts.writeArtistVariants(artist_id, allVariants, sourcesPresent);
          totals.source_rows_written += outcome.variants_written;
        } catch (error) {
          totals.writer_errors += 1;
          log('warn', 'writer_error', `writer failed for artist_id=${artist_id}`, {
            artist_id,
            error_message: (error as Error).message,
          });
          captureError(error, 'writer_error', { artist_id });
        }
      }
    }

    // One aggregate cardinality-drift event per batch, if any drift seen.
    // Sample the first few names so the Sentry payload stays bounded even
    // under wholesale upstream drift.
    if (unaccountedInBatch.length > 0) {
      const sample = unaccountedInBatch.slice(0, 10);
      log(
        'warn',
        'cardinality_drift',
        `LML omitted ${unaccountedInBatch.length} input names from both artists[] and missing[]`,
        {
          batch_index: batchIndex,
          unaccounted_count: unaccountedInBatch.length,
          sample,
        }
      );
      captureError(
        new Error(
          `LML cardinality drift: ${unaccountedInBatch.length} input names in batch ${batchIndex} not in artists[] or missing[]`
        ),
        'cardinality_drift',
        { batch_index: batchIndex, unaccounted_count: unaccountedInBatch.length, sample }
      );
    }

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      cursor,
      ...totals,
    });

    if (opts.throttleMs > 0) await sleep(opts.throttleMs);
  }

  const dryRunReport: DryRunReport | null = opts.dryRun
    ? {
        names_scanned: totals.names_scanned,
        would_resolve: totals.names_resolved,
        would_missing: totals.names_missing,
        would_write_rows: totals.would_write_rows,
        lml_total_calls: totals.lml_total_calls,
        lml_total_latency_ms: totals.lml_total_latency_ms,
      }
    : null;

  if (dryRunReport) {
    process.stdout.write(JSON.stringify(dryRunReport) + '\n');
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return { totals, dryRunReport };
};
