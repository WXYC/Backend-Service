/**
 * Orchestrator for jobs/concerts-similar-artists-enrichment (BS#1626).
 *
 * Unit of work: `(in-library headliner artist → semantic-index affinity
 * neighbors → artist_similar_artists row)`. Loads the cohort (distinct
 * `artists.id` of upcoming curated in-library headliners), chunks it through
 * semantic-index's batch neighbors endpoint (WXYC/semantic-index#354), and
 * OVERWRITES the artist-level rows — a full-window nightly re-fetch, not a
 * presence anti-join, so neighbors stay current with the nightly graph rebuild.
 *
 * Refresh + write model (differs from the genre sibling):
 *   - non-empty verdict → UPSERT (overwrite) the neighbor list.
 *   - empty verdict from a RESPONDED chunk → DELETE the row (the genuine
 *     now-unmapped/ambiguous ~1%).
 *   - a chunk whose fetch THROWS → counted as errors; its ids enter NEITHER
 *     the upsert NOR the delete set, so their existing rows survive and are
 *     retried next run (transport failures must never wipe a healthy row).
 *
 * Null-wipe guard: if EVERY responded id came back empty (a non-empty cohort),
 * that is the integration-day "mapping not yet rebuilt" case (or a real fault).
 * The run logs loudly with `/health` `mapped_artist_count` and writes NOTHING —
 * never wiping the collected rows. A broad-but-partial empties (empty fraction
 * above `EMPTY_DELETE_FRACTION_CEIL`) suppresses the DELETE branch too: a
 * partial mapping rebuild shouldn't clear rows, while a genuine ~1% churn still
 * clears.
 *
 * Dep-injected so the unit suite drives the loop without PG or the network —
 * see tests/unit/jobs/concerts-similar-artists-enrichment/orchestrate.test.ts.
 */

import type { NeighborsBatchResponse, SimilarArtistNeighbor } from './neighbors-client.js';
import type { EnrichmentCandidate } from './query.js';
import type { SimilarArtistsRow } from './writer.js';
import { captureError, log } from './logger.js';

/**
 * Above this fraction of empty responded ids, the DELETE branch is suppressed —
 * a broad empties smells like a partial mapping rebuild, not real churn. A
 * genuine now-unmapped cohort is the ~1% homonym tail, far below this. UPSERTs
 * of the non-empty verdicts still proceed; only the row-clearing is held back.
 */
export const EMPTY_DELETE_FRACTION_CEIL = 0.2;

export type Totals = {
  /** In-library headliners loaded (distinct artists.id). */
  cohort: number;
  /** Endpoint chunks that received a response. */
  chunks: number;
  /** Ids across all responded chunks (present in `results`). */
  fetched: number;
  /** Of `fetched`, how many came back with >= 1 neighbor. */
  with_neighbors: number;
  /** Total neighbor rows across all non-empty lists. */
  neighbors_total: number;
  /** Rows written (inserted-or-overwritten). */
  enriched: number;
  /** Rows deleted (responded-empty artists, when the DELETE branch ran). */
  cleared: number;
  /** Ids on chunks whose fetch threw — left untouched + retryable. */
  errors: number;
  /** Set when a whole sweep came back empty and the run wrote nothing. */
  all_empty_skip: boolean;
  /** Set when the DELETE branch was suppressed by the empty-fraction ceiling. */
  deletes_suppressed: boolean;
};

export const emptyTotals = (): Totals => ({
  cohort: 0,
  chunks: 0,
  fetched: 0,
  with_neighbors: 0,
  neighbors_total: 0,
  enriched: 0,
  cleared: 0,
  errors: 0,
  all_empty_skip: false,
  deletes_suppressed: false,
});

export interface EnrichDeps {
  /** Distinct in-library headliner artist ids (upcoming curated). */
  loadCandidates: () => Promise<EnrichmentCandidate[]>;
  /** One endpoint chunk (<= cap ids). Throws on transport/HTTP/shape failure. */
  fetchNeighbors: (libraryArtistIds: number[]) => Promise<NeighborsBatchResponse>;
  /** Best-effort `/health` probe, read only to enrich the all-empty loud log. */
  fetchHealth: () => Promise<{ mapped_artist_count: number | null }>;
  /** Overwrite the cohort's rows (UPSERT + scoped DELETE); returns counts. */
  overwrite: (upserts: SimilarArtistsRow[], deleteArtistIds: number[]) => Promise<{ written: number; deleted: number }>;
  /** Cooperative pause — awaited before each chunk. */
  awaitQuiet?: () => Promise<void>;
}

export interface EnrichOptions {
  /** Top-K neighbors per headliner (K=20 in production). */
  limit: number;
  /** Ids per endpoint chunk (<= SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP). */
  chunkSize: number;
  dryRun: boolean;
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const runEnrichment = async (deps: EnrichDeps, options: EnrichOptions): Promise<Totals> => {
  const totals = emptyTotals();

  const candidates = await deps.loadCandidates();
  totals.cohort = candidates.length;

  const chunks = chunk(
    candidates.map((c) => c.artist_id),
    options.chunkSize
  );
  log('info', 'enumerated', `${candidates.length} in-library headliners in the upcoming curated window`, {
    cohort: candidates.length,
    planned_chunks: chunks.length,
    chunk_size: options.chunkSize,
    limit: options.limit,
  });

  if (candidates.length === 0) return totals;

  if (options.dryRun) {
    log('info', 'dry_run_plan', `(dry-run) would send ${chunks.length} chunk(s) of up to ${options.chunkSize} ids`, {
      planned_chunks: chunks.length,
    });
    return totals;
  }

  // Collect verdicts only for ids on RESPONDED chunks. A thrown chunk's ids
  // never enter this map, so they are neither upserted nor deleted.
  const fetched = new Map<number, SimilarArtistNeighbor[]>();

  for (const ids of chunks) {
    if (deps.awaitQuiet) await deps.awaitQuiet();

    let response: NeighborsBatchResponse;
    try {
      response = await deps.fetchNeighbors(ids);
    } catch (err) {
      // Transport / HTTP / shape failure: nothing recorded for this chunk, so
      // its ids keep their existing rows and are re-fetched next run. Never
      // abort the whole run over one chunk.
      totals.errors += ids.length;
      log('warn', 'chunk_failed', `fetchNeighbors threw; chunk of ${ids.length} left retryable`, {
        chunk_size: ids.length,
        first_artist_id: ids[0] ?? null,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'chunk_failed', { chunk_size: ids.length });
      continue;
    }
    totals.chunks += 1;

    for (const id of ids) {
      // Contract guarantees every requested id is present as an array; treat a
      // missing OR malformed (non-array) value as [] defensively — `Array.isArray`
      // (not `?? []`) so a stray non-array truthy can neither be written into the
      // jsonb column as garbage nor slip past the empty check.
      const raw = response.results[String(id)];
      const list = Array.isArray(raw) ? raw : [];
      fetched.set(id, list);
      totals.fetched += 1;
      if (list.length > 0) {
        totals.with_neighbors += 1;
        totals.neighbors_total += list.length;
      }
    }
  }

  // Null-wipe guard: a wholly-empty sweep over a non-empty responded set is the
  // "mapping not yet rebuilt" case (or a real fault). Write nothing.
  if (fetched.size > 0 && totals.with_neighbors === 0) {
    const health = await deps.fetchHealth();
    totals.all_empty_skip = true;
    log(
      'error',
      'all_empty_sweep',
      `all ${fetched.size} responded headliners returned empty neighbor lists; skipping write (no null wipe)`,
      {
        responded: fetched.size,
        mapped_artist_count: health.mapped_artist_count,
        hint:
          health.mapped_artist_count !== null && health.mapped_artist_count > 0
            ? 'graph reports a healthy mapped_artist_count — likely a real fault or an all-unmapped cohort, not a bootstrap'
            : 'mapped_artist_count is 0/null — mapping not yet rebuilt (bootstrap night); expected pre-rebuild',
      }
    );
    return totals;
  }

  // Partition responded verdicts into overwrite (non-empty) and clear (empty).
  const upserts: SimilarArtistsRow[] = [];
  const emptyIds: number[] = [];
  for (const [artist_id, neighbors] of fetched) {
    if (neighbors.length > 0) upserts.push({ artist_id, neighbors });
    else emptyIds.push(artist_id);
  }

  // Suppress the DELETE branch on a broad-but-partial empties — a partial
  // mapping rebuild shouldn't clear rows. A genuine ~1% churn stays well under
  // the ceiling and clears normally.
  const emptyFraction = fetched.size > 0 ? emptyIds.length / fetched.size : 0;
  let deleteIds = emptyIds;
  if (emptyIds.length > 0 && emptyFraction > EMPTY_DELETE_FRACTION_CEIL) {
    totals.deletes_suppressed = true;
    deleteIds = [];
    log(
      'warn',
      'deletes_suppressed',
      `empty fraction ${(emptyFraction * 100).toFixed(1)}% exceeds ${(EMPTY_DELETE_FRACTION_CEIL * 100).toFixed(0)}%; suppressing ${emptyIds.length} DELETE(s) (possible partial rebuild)`,
      { empty_ids: emptyIds.length, responded: fetched.size, empty_fraction: emptyFraction }
    );
  }

  try {
    const { written, deleted } = await deps.overwrite(upserts, deleteIds);
    totals.enriched = written;
    totals.cleared = deleted;
  } catch (err) {
    // A write failure leaves the cohort's rows as they were (retryable next
    // run). Count the attempted writes as errors and continue to return.
    totals.errors += upserts.length + deleteIds.length;
    log(
      'warn',
      'overwrite_failed',
      `overwriteNeighbors threw for ${upserts.length} upsert(s) + ${deleteIds.length} delete(s)`,
      {
        upserts: upserts.length,
        deletes: deleteIds.length,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      }
    );
    captureError(err, 'overwrite_failed', { upserts: upserts.length, deletes: deleteIds.length });
  }

  return totals;
};
