/**
 * Backfill orchestrator for #637 (library.artwork_url warm).
 *
 * Iterates `library` rows joined to `artists` where `artwork_url IS NULL` and
 * the artist has a Discogs identity (`discogs_artist_id IS NOT NULL`). Calls
 * LML for each one, and applies the single-column UPDATE via `applyEnrichment`.
 * Designed to be resumable and failure-tolerant:
 *
 *   - The WHERE filter is `l.artwork_url IS NULL AND a.discogs_artist_id IS
 *     NOT NULL`. Re-running picks up only rows the previous run didn't
 *     finish. Caveat: no-match rows from a prior run are also re-queried —
 *     accepted per the issue, since the resolvable set is bounded (~18.5K)
 *     and the job is one-shot.
 *   - Within a single run, batches paginate by `library.id` (last-id cursor).
 *     Across runs, the WHERE filter is what restarts — the cursor doesn't
 *     need to persist.
 *   - One LML failure is logged, counted as `lml_error`, and the loop
 *     continues. The row stays NULL so a future sweep retries it.
 *
 * Race interaction with the search-path runtime: `enrichWithArtwork` (in the
 * backend service) writes `library.artwork_url` on first lookup of un-cached
 * albums. The job's `applyEnrichment` narrows its UPDATE by
 * `artwork_url IS NULL`, so a row the runtime stamps between the
 * orchestrator's SELECT and the job's UPDATE matches 0 rows — the
 * `enriched_match_raced` counter tracks this case, useful operational signal
 * but not a correctness concern (both writers source from the same LML
 * response, which itself sources from `discogs-cache.release.artwork_url`).
 * The reverse direction — runtime UPDATE landing AFTER the job's UPDATE —
 * required hardening on the runtime side: see #718 / PR #720, which adds the
 * symmetric `AND artwork_url IS NULL` predicate to
 * `library.service.ts:updateArtworkUrl` so the two writers no longer fight.
 *
 * The `lookup` and `enrich` functions are injected so tests can drive the
 * orchestration without a live LML or DB. Production wires them to
 * `lml-fetch.ts:lookupMetadata` and `enrich.ts:applyEnrichment`.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';
import type { LmlLookupResponse } from './lml-types.js';
import type { EnrichRow, EnrichOutcome } from './enrich.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'library-artwork-url-backfill';

export const BATCH_SIZE = 500;

/**
 * Default inter-call delay between LML lookups, in ms. The same baseline as
 * flowsheet-metadata-backfill (#638): ~600 req/min at 100ms — well above
 * Discogs's 50/min ceiling, but LML caches and gates Discogs upstream itself
 * so most calls are local PG reads (`discogs-cache.release.artwork_url`).
 * The orchestrator's job is to keep one in-flight at a time, not to directly
 * enforce the Discogs budget. Raise via `BACKFILL_THROTTLE_MS` if needed.
 * Tests override to 0.
 */
export const THROTTLE_MS = 100;

/**
 * Schema-qualified table references, honoring `WXYC_SCHEMA_NAME` so parallel
 * Jest workers (which override the env var) and any future integration test
 * harness target the right schema. Default `wxyc_schema` matches production.
 * Sanitised against `"` to keep the SQL well-formed.
 */
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/**
 * Resolve `BACKFILL_BATCH_SIZE` from the environment, falling back to
 * `BATCH_SIZE`. Mirrors `flowsheet-metadata-backfill/orchestrate.ts:resolveBatchSize`
 * — operators tune via `docker run -e BACKFILL_BATCH_SIZE=...`.
 *
 * Exported so unit tests can drive it without mucking with process.env.
 */
export const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number => {
  if (raw === undefined) return BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid BACKFILL_BATCH_SIZE=${JSON.stringify(raw)}; must be a positive integer.`);
  }
  return parsed;
};

/**
 * Resolve `BACKFILL_THROTTLE_MS` from the environment, falling back to
 * `THROTTLE_MS`. Operators tighten this if a future LML configuration
 * tightens its own client-side cap, or set 0 in pilot/CI runs to remove
 * the inter-row sleep.
 *
 * Exported so unit tests can drive it without mucking with process.env.
 */
export const resolveThrottleMs = (raw: string | undefined = process.env.BACKFILL_THROTTLE_MS): number => {
  if (raw === undefined) return THROTTLE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid BACKFILL_THROTTLE_MS=${JSON.stringify(raw)}; must be a non-negative integer.`);
  }
  return parsed;
};

/**
 * Resolve PARTITION_INDEX / PARTITION_COUNT env vars into a SQL fragment that
 * picks every Nth row by id-modulo. Mirrors the precedent in
 * `flowsheet-metadata-backfill`. The N-container deploy pattern is:
 *
 *   PARTITION_COUNT=4 PARTITION_INDEX=0 docker run ...
 *   PARTITION_COUNT=4 PARTITION_INDEX=1 docker run ...
 *   ...
 *
 * Each container processes a disjoint subset and they finish in roughly the
 * same wall time. The default (count=1, index=0) is a no-op pass-through.
 *
 * Exported so unit tests can drive it without mucking with process.env.
 */
export const resolvePartitionFilter = (
  rawIndex: string | undefined = process.env.PARTITION_INDEX,
  rawCount: string | undefined = process.env.PARTITION_COUNT,
  columnSql: SQL = sql`l."id"`
): { sqlFragment: SQL | null; description: string } => {
  const count = rawCount === undefined ? 1 : Number(rawCount);
  const index = rawIndex === undefined ? 0 : Number(rawIndex);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid PARTITION_COUNT=${JSON.stringify(rawCount)}; must be a positive integer.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `Invalid PARTITION_INDEX=${JSON.stringify(rawIndex)}; must be 0 <= index < PARTITION_COUNT (${count}).`
    );
  }
  if (count === 1) {
    return { sqlFragment: null, description: 'partition=none' };
  }
  return {
    sqlFragment: sql`AND (${columnSql} % ${count}) = ${index}`,
    description: `partition=${index}/${count}`,
  };
};

export type LookupFn = (artist: string, album?: string) => Promise<LmlLookupResponse>;

export type EnrichFn = (row: EnrichRow, response: LmlLookupResponse) => Promise<EnrichOutcome>;

export type Totals = {
  scanned: number;
  enriched_match: number;
  enriched_match_raced: number;
  enriched_no_match: number;
  lml_error: number;
};

export type ProcessOutcome = EnrichOutcome | 'lml_error';

export type RunResult = {
  totals: Totals;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive a single row through lookup → enrich. The result is the outcome
 * status (or 'lml_error' when LML threw). Errors are logged and consumed;
 * they do not bubble up so a single bad row cannot abort the run. The row
 * stays `artwork_url IS NULL` so the next sweep retries it.
 */
export const processRow = async (
  row: EnrichRow,
  deps: { lookup: LookupFn; enrich: EnrichFn }
): Promise<ProcessOutcome> => {
  const artist = row.artist_name;
  const album = row.album_title;

  let response: LmlLookupResponse;
  try {
    response = await deps.lookup(artist, album);
  } catch (error) {
    log('warn', 'lml_error', `LML lookup failed for library.id=${row.id}`, {
      library_id: row.id,
      error_message: (error as Error).message,
    });
    captureError(error, 'lml_error', { library_id: row.id, artist, album });
    return 'lml_error';
  }

  return deps.enrich(row, response);
};

/**
 * Read the next batch of unprocessed library rows.
 *
 * Joins `library` to `artists` so the WHERE can filter by both
 * `l.artwork_url IS NULL` and `a.discogs_artist_id IS NOT NULL` — the latter
 * is the "Discogs-resolvable" gate per #637. The id-cursor predicate keeps
 * the SELECT bounded as the run progresses.
 *
 * `artist_name` is sourced from the artists join (always populated; `library.
 * artist_id` is NOT NULL per schema) rather than `library.artist_name` (which
 * was nullable until A.2's backfill shipped) — guarantees a non-null artist
 * for the LML lookup regardless of A.2 backfill state.
 *
 * No supporting partial index. The flowsheet-metadata-backfill precedent
 * relies on `flowsheet_metadata_attempt_pending_idx` (#659) because that
 * job scans the 1.86M-row flowsheet tail. This job's eligible set is
 * bounded by the ~24% of artists with a Discogs identity (~5.7K) joined
 * to their library rows (~18.5K out of 64K total), small enough that an
 * unindexed seq-scan-then-hash-join per ~37 batches is acceptable for a
 * one-shot pass during a low-traffic window. If this becomes recurring or
 * the resolvable set grows materially, ship a partial index migration:
 * `CREATE INDEX CONCURRENTLY library_artwork_pending_idx ON
 * wxyc_schema.library (id) WHERE artwork_url IS NULL` (paired with the
 * artists join, per the deploy runbook for index-with-IF-NOT-EXISTS in
 * CLAUDE.md).
 */
const loadBatch = async (afterId: number, batchSize: number, partitionFilter: SQL | null): Promise<EnrichRow[]> => {
  const partitionClause = partitionFilter ?? sql``;
  const rows = (await db.execute(sql`
    SELECT
      l."id",
      a."artist_name" AS "artist_name",
      l."album_title"
    FROM ${LIBRARY_TABLE} AS l
    JOIN ${ARTISTS_TABLE} AS a ON a."id" = l."artist_id"
    WHERE l."artwork_url" IS NULL
      AND a."discogs_artist_id" IS NOT NULL
      AND l."id" > ${afterId}
      ${partitionClause}
    ORDER BY l."id" ASC
    LIMIT ${batchSize}
  `)) as unknown as EnrichRow[];
  return rows ?? [];
};

const formatTotals = (totals: Totals): string =>
  `scanned=${totals.scanned} enriched_match=${totals.enriched_match} ` +
  `enriched_match_raced=${totals.enriched_match_raced} ` +
  `enriched_no_match=${totals.enriched_no_match} lml_error=${totals.lml_error}`;

export const runBackfill = async (opts: {
  lookup: LookupFn;
  enrich: EnrichFn;
  batchSize?: number;
  throttleMs?: number;
  partition?: { sqlFragment: SQL | null; description: string };
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const throttleMs = opts.throttleMs ?? resolveThrottleMs();
  const partition = opts.partition ?? resolvePartitionFilter();

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: batchSize,
    throttle_ms: throttleMs,
    partition: partition.description,
  });

  const totals: Totals = {
    scanned: 0,
    enriched_match: 0,
    enriched_match_raced: 0,
    enriched_no_match: 0,
    lml_error: 0,
  };
  let lastId = 0;
  let batchIndex = 0;

  while (true) {
    const rows = await loadBatch(lastId, batchSize, partition.sqlFragment);
    if (rows.length === 0) break;

    batchIndex += 1;
    for (const row of rows) {
      const status = await processRow(row, { lookup: opts.lookup, enrich: opts.enrich });
      totals.scanned += 1;
      totals[status] += 1;
      lastId = row.id;
      if (throttleMs > 0) await sleep(throttleMs);
    }

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      last_id: lastId,
      ...totals,
    });
  }

  log('info', 'finished', `${JOB_NAME} done. ${formatTotals(totals)}`, { ...totals });
  return { totals };
};
