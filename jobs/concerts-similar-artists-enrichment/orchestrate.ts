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
import type { StationPlaysRow } from './station-writer.js';
import { captureError, log } from './logger.js';

/**
 * The DELETE branch is suppressed only when BOTH bounds trip: more than
 * `EMPTY_DELETE_FRACTION_CEIL` of the responded ids came back empty AND at least
 * `EMPTY_DELETE_MIN_COUNT` of them did. A broad wave of empties smells like a
 * partial mapping rebuild, not real churn — so hold back the row-clearing (the
 * UPSERTs of the non-empty verdicts still proceed). The absolute floor keeps a
 * SMALL cohort honest: on a slow week with ≤4 upcoming headliners, a single
 * genuinely now-unmapped one is >20% of the set but is real churn, not a
 * rebuild, so it must still clear. A genuine now-unmapped cohort is the ~1%
 * homonym tail; a real partial rebuild empties many rows at once.
 */
export const EMPTY_DELETE_FRACTION_CEIL = 0.2;
export const EMPTY_DELETE_MIN_COUNT = 3;

export type Totals = {
  /** In-library headliners loaded (distinct artists.id). */
  cohort: number;
  /** Endpoint chunks that received a response. */
  chunks: number;
  /** Ids on responded chunks with a well-formed (array) verdict. */
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
  /**
   * Ids on a RESPONDED chunk that were absent from `results` or carried a
   * non-array value (a contract violation). Skipped — NOT routed to the DELETE
   * set — so an upstream omission can't clear a healthy row; retried next run.
   */
  malformed: number;
  /** Set when the overwrite transaction threw (cohort left as-is, retryable). */
  write_failed: boolean;
  /** Set when a whole sweep came back empty and the run wrote nothing. */
  all_empty_skip: boolean;
  /** Set when the DELETE branch was suppressed by the empty-fraction/count guard. */
  deletes_suppressed: boolean;
  /**
   * Station-plays rows written (BS#1702). Accounted separately from `enriched`
   * because the station write lands BEFORE the neighbors null-wipe early return —
   * a heavily-played headliner with no neighbors still gets its count.
   */
  station_written: number;
  /**
   * Set when a RESPONDED run returned no `source_plays` for any headliner and the
   * station write wrote nothing (semantic-index#369 not yet deployed, or a fault).
   * Benign — never a null wipe (this table is UPSERT-only) and never a non-zero
   * exit; `station_plays` is documented harmless before it's populated.
   */
  station_empty_skip: boolean;
  /** Set when the station-plays UPSERT threw (rows left as-is, retryable). */
  station_write_failed: boolean;
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
  malformed: 0,
  write_failed: false,
  all_empty_skip: false,
  deletes_suppressed: false,
  station_written: 0,
  station_empty_skip: false,
  station_write_failed: false,
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
  /** UPSERT the cohort's station-plays rows (BS#1702; UPSERT-only, no DELETE). */
  writeStation: (rows: StationPlaysRow[]) => Promise<{ written: number }>;
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
  // BS#1702: station play counts collected across chunks, INDEPENDENTLY of the
  // neighbor verdicts. Persisted before the neighbors null-wipe early return so a
  // heavily-played artist with no neighbors still gets its count.
  const stationPlays = new Map<number, number>();

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
      // BS#1702: the station play count is independent of the neighbor verdict —
      // collect it first so a malformed/absent/empty neighbor list doesn't skip a
      // valid play count. The client already validated each value to a
      // non-negative integer, so a present value is trustworthy; an absent one is
      // simply not recorded (semantic-index#369 not deployed, or no play data).
      const plays = response.source_plays[String(id)];
      if (typeof plays === 'number') stationPlays.set(id, plays);

      // The contract guarantees every requested id is present as an array (the
      // client already sanitized well-formed arrays to `{artist_id, weight}` and
      // dropped non-array values). An id ABSENT here is therefore a contract
      // violation / partial upstream fault — NOT an observed-empty verdict. Route
      // it to `malformed` (skip + retry next run), never into `fetched`: an
      // observed-empty `[]` is delete-eligible, but an omission must never clear
      // a healthy row (the writer's stated invariant).
      const raw = response.results[String(id)];
      if (!Array.isArray(raw)) {
        totals.malformed += 1;
        log('warn', 'malformed_verdict', `id ${id} absent/non-array in results; skipping (retryable)`, {
          artist_id: id,
        });
        continue;
      }
      fetched.set(id, raw);
      totals.fetched += 1;
      if (raw.length > 0) {
        totals.with_neighbors += 1;
        totals.neighbors_total += raw.length;
      }
    }
  }

  // A malformed/absent verdict is a semantic-index contract violation (the
  // endpoint guarantees every requested id present as an array), never an
  // expected outcome like an empty list — so raise ONE aggregate Sentry signal
  // per run (the per-id `warn` logs above stay for CloudWatch). This is what
  // makes a persistent partial-omission run visible even when it still wrote
  // some rows and therefore exits 0.
  if (totals.malformed > 0) {
    captureError(
      new Error(`${totals.malformed} malformed/absent neighbor verdict(s) — semantic-index contract violation`),
      'malformed_verdicts',
      { malformed: totals.malformed, cohort: totals.cohort }
    );
  }

  // BS#1702 station-plays write — persisted HERE, BEFORE the neighbors null-wipe
  // early return, and via its own writer/table: a heavily-played headliner with
  // no affinity neighbors must still get its `station_plays` count (that is the
  // cold-start "For You" card this feature exists to surface). UPSERT-only, no
  // DELETE — a stale count is harmless. Independent of the neighbor write in
  // every way: it runs even when the neighbors sweep is all-empty, and a
  // station-write failure leaves the neighbor path untouched (and vice versa).
  const stationRows: StationPlaysRow[] = Array.from(stationPlays, ([artist_id, plays]) => ({ artist_id, plays }));
  if (stationRows.length === 0) {
    // Station empty-map guard, mirroring the neighbors `all_empty_sweep`: a
    // RESPONDED run (>=1 chunk came back) with no `source_plays` for any
    // headliner means the endpoint isn't returning the field yet
    // (semantic-index#369 undeployed) or faulted. Write nothing and record the
    // benign skip — never read "endpoint returned no plays" as "all artists have
    // 0 plays" (which would UPSERT zeros over real counts). Not set on a total
    // outage (no chunk responded) — that is already carried by `errors`.
    if (totals.chunks > 0) {
      totals.station_empty_skip = true;
      log(
        'warn',
        'station_empty_sweep',
        `no source_plays returned for any of ${totals.chunks} responded chunk(s); writing no station plays`,
        {
          responded_chunks: totals.chunks,
          hint: 'semantic-index#369 (source_plays on neighbors/batch) may not be deployed yet — station_plays stays null on the wire, which is harmless',
        }
      );
    }
  } else {
    try {
      const { written } = await deps.writeStation(stationRows);
      totals.station_written = written;
    } catch (err) {
      // A station-write failure leaves the rows as they were (retryable next
      // run). Flag it (distinct from the neighbor `write_failed`) so the
      // entrypoint's exit-code check can alert; the neighbor path is untouched.
      totals.station_write_failed = true;
      log('warn', 'station_write_failed', `writeStationPlays threw for ${stationRows.length} row(s)`, {
        rows: stationRows.length,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'station_write_failed', { rows: stationRows.length });
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

  // Suppress the DELETE branch only on a BROAD wave of empties (both bounds: a
  // >CEIL fraction AND at least MIN_COUNT of them) — the signature of a partial
  // mapping rebuild, which shouldn't clear rows. A small number of genuine
  // now-unmapped headliners (the ~1% churn) stays under the count floor and
  // clears normally even in a tiny cohort where it exceeds the fraction.
  const emptyFraction = fetched.size > 0 ? emptyIds.length / fetched.size : 0;
  let deleteIds = emptyIds;
  if (emptyIds.length >= EMPTY_DELETE_MIN_COUNT && emptyFraction > EMPTY_DELETE_FRACTION_CEIL) {
    totals.deletes_suppressed = true;
    deleteIds = [];
    log(
      'warn',
      'deletes_suppressed',
      `${emptyIds.length} empty verdicts (${(emptyFraction * 100).toFixed(1)}% of responded, > ${(EMPTY_DELETE_FRACTION_CEIL * 100).toFixed(0)}%); suppressing DELETEs (possible partial rebuild)`,
      { empty_ids: emptyIds.length, responded: fetched.size, empty_fraction: emptyFraction }
    );
  }

  try {
    const { written, deleted } = await deps.overwrite(upserts, deleteIds);
    totals.enriched = written;
    totals.cleared = deleted;
  } catch (err) {
    // A write failure leaves the cohort's rows as they were (retryable next
    // run). Flag it (distinct from per-chunk fetch `errors`) so the entrypoint's
    // exit-code check can alert; the row set is untouched.
    totals.write_failed = true;
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
