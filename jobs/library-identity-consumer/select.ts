/**
 * SELECT predicate for the library-identity-consumer job (BS#802).
 *
 * Picks libraries needing identity refresh under the post-#800 pivot
 * (Backend is thin-writer; LML is sole composer):
 *
 *   library.canonical_entity_id IS NOT NULL
 *   AND (
 *     NOT EXISTS (SELECT 1 FROM library_identity WHERE library_id = library.id)
 *     OR EXISTS (
 *       SELECT 1 FROM library_identity
 *       WHERE library_id = library.id
 *         AND last_verified_at < NOW() - interval '7 days'
 *     )
 *   )
 *
 * BS#1144: the predicate used to be `canonical_entity_id IS NOT NULL OR ...`
 * — an unconditional disjunct that re-fetched every canonicalized row on
 * every run regardless of freshness, burning LML quota. The freshness guard
 * above narrows eligibility to rows with no `library_identity` row yet, or
 * whose existing row is stale. This intentionally does NOT bring
 * NULL-canonical_entity_id rows into scope — that's #974's separate,
 * hand-shipped work, and doing so here would create an unresolved-row
 * hot-loop.
 *
 * Note on the column name: BS#802's ticket body wrote `last_refreshed_at`,
 * but the column on `library_identity` is `last_verified_at`. We use
 * `last_verified_at` — this is the actual schema, and the PR body calls
 * the rename out so the reviewer sees the correction.
 *
 * Schema-qualified table refs honor `WXYC_SCHEMA_NAME` so Jest workers
 * (which override the env var) target the right schema. Sanitised against
 * `"` to keep the SQL well-formed. Same shape as
 * `library-identity-backfill/orchestrate.ts`.
 *
 * Pagination is via the canonical id-cursor pattern (last-id cursor + LIMIT)
 * with optional PARTITION_INDEX / PARTITION_COUNT modulo for N-container
 * parallel runs.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const LIBRARY_IDENTITY_TABLE = sql.raw(`"${SCHEMA}"."library_identity"`);

export type LibraryRow = {
  id: number;
  artist_name: string;
  album_title: string;
};

/**
 * Resolve `BATCH_SIZE` from the env, falling back to `defaultBatchSize`.
 * LML caps the bulk endpoint at 1000 inputs per request; the default is 500
 * for headroom (per BS#802).
 */
export const resolveBatchSize = (raw: string | undefined = process.env.BATCH_SIZE, defaultBatchSize = 500): number => {
  if (raw === undefined) return defaultBatchSize;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error(`Invalid BATCH_SIZE=${JSON.stringify(raw)}; must be a positive integer ≤ 1000 (LML cap).`);
  }
  return parsed;
};

export const resolveThrottleMs = (raw: string | undefined = process.env.THROTTLE_MS, defaultMs = 100): number => {
  if (raw === undefined) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid THROTTLE_MS=${JSON.stringify(raw)}; must be a non-negative integer.`);
  }
  return parsed;
};

export const resolvePartitionFilter = (
  rawIndex: string | undefined = process.env.PARTITION_INDEX,
  rawCount: string | undefined = process.env.PARTITION_COUNT
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
    sqlFragment: sql`AND (${LIBRARY_TABLE}."id" % ${count}) = ${index}`,
    description: `partition=${index}/${count}`,
  };
};

export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

export const resolveStaleThreshold = (
  raw: string | undefined = process.env.STALE_THRESHOLD_DAYS,
  defaultDays = 7
): number => {
  if (raw === undefined) return defaultDays;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid STALE_THRESHOLD_DAYS=${JSON.stringify(raw)}; must be a positive integer.`);
  }
  return parsed;
};

/**
 * Load the next batch of libraries needing identity refresh.
 *
 * The predicate is the canonicalized-and-fresh gate described above. Rows are skipped when
 * `artist_name` or `album_title` is NULL — LML's bulk endpoint requires
 * both. (`album_title` is NOT NULL in the schema, but `artist_name` is
 * nullable until the Epic A.2 backfill completes for any future-added
 * rows.)
 *
 * The id-cursor predicate keeps the SELECT bounded as the run progresses.
 */
export const loadBatch = async (
  afterId: number,
  batchSize: number,
  partitionFilter: SQL | null,
  staleDays: number
): Promise<LibraryRow[]> => {
  const partitionClause = partitionFilter ?? sql``;
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title"
    FROM ${LIBRARY_TABLE}
    WHERE "id" > ${afterId}
      AND "artist_name" IS NOT NULL
      AND "canonical_entity_id" IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li
          WHERE li."library_id" = ${LIBRARY_TABLE}."id"
        )
        OR EXISTS (
          SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li
          WHERE li."library_id" = ${LIBRARY_TABLE}."id"
            AND li."last_verified_at" < NOW() - (interval '1 day' * ${staleDays})
        )
      )
      ${partitionClause}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as LibraryRow[];
  return rows ?? [];
};
