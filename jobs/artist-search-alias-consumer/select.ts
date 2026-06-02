/**
 * SELECT predicate for the artist-search-alias-consumer job (BS#1266).
 *
 * Picks distinct WXYC `library.artist_name` values needing alias refresh,
 * grouped to the set of `artists.id`s sharing each name (no UNIQUE on
 * `artists.artist_name`; one name can map to many artist_ids). The
 * orchestrator fans alias variants out to every artist_id in a group.
 *
 * Refresh predicate per the artist-search-alias plan PR 4:
 *
 *   NOT EXISTS (any artist_search_alias row for any artist_id in the group)
 *   OR EXISTS (a stale alias row in the group)
 *
 * Cursor is `artist_name`-shaped (text), because the SELECT groups by name.
 * Partition uses `hashtext(n.artist_name) % PARTITION_COUNT = PARTITION_INDEX`
 * so distinct names land in distinct partitions deterministically across
 * runs. PARTITION_COUNT=1 short-circuits the modulo via a guard in the SQL
 * so single-container runs pay no hash overhead.
 *
 * Schema-qualified table refs honour `WXYC_SCHEMA_NAME` so parallel Jest
 * workers (which override the env var) target the right schema. Sanitised
 * against `"` to keep the SQL well-formed.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTIST_SEARCH_ALIAS_TABLE = sql.raw(`"${SCHEMA}"."artist_search_alias"`);

export type NameGroup = {
  artist_name: string;
  artist_ids: number[];
};

export type Partition = {
  index: number;
  count: number;
  description: string;
};

/**
 * Resolve `BATCH_SIZE` from the env, falling back to `defaultBatchSize`.
 * LML caps the bulk endpoint at 1000 names per request; the default is 500
 * for headroom.
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

export const resolvePartition = (
  rawIndex: string | undefined = process.env.PARTITION_INDEX,
  rawCount: string | undefined = process.env.PARTITION_COUNT
): Partition => {
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
  return {
    index,
    count,
    description: count === 1 ? 'partition=none' : `partition=${index}/${count}`,
  };
};

export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

/**
 * Load the next batch of name groups that need an alias refresh.
 *
 * `cursor` is the previous batch's last `artist_name` — pass `''` for the
 * first batch (every real artist_name sorts greater than the empty string).
 * The text cursor is advanced by the *batch tail*, not by `eligible`, so
 * an all-V/A batch cannot get stuck re-loading the same range forever.
 *
 * `partition.count = 1` skips the hashtext modulo at the SQL level so the
 * single-container case pays nothing for the parallelism mechanism.
 */
export const loadNameGroups = async (
  cursor: string,
  batchSize: number,
  partition: Partition,
  staleDays: number
): Promise<NameGroup[]> => {
  const result: unknown = await db.execute(sql`
    WITH name_to_artists AS (
      SELECT
        l."artist_name",
        array_agg(DISTINCT l."artist_id" ORDER BY l."artist_id") AS artist_ids
      FROM ${LIBRARY_TABLE} l
      WHERE l."artist_name" IS NOT NULL
      GROUP BY l."artist_name"
    )
    SELECT n."artist_name", n.artist_ids
    FROM name_to_artists n
    WHERE n."artist_name" > ${cursor}
      AND (
        NOT EXISTS (
          SELECT 1 FROM ${ARTIST_SEARCH_ALIAS_TABLE} asa
          WHERE asa."artist_id" = ANY(n.artist_ids)
        )
        OR EXISTS (
          SELECT 1 FROM ${ARTIST_SEARCH_ALIAS_TABLE} asa
          WHERE asa."artist_id" = ANY(n.artist_ids)
            AND asa."last_verified_at" < NOW() - (interval '1 day' * ${staleDays})
          LIMIT 1
        )
      )
      AND (${partition.count} = 1 OR abs(hashtext(n."artist_name")::bigint) % ${partition.count} = ${partition.index})
    ORDER BY n."artist_name"
    LIMIT ${batchSize}
  `);

  // Drizzle's `execute` returns the raw driver shape — for postgres-js that's
  // an array, but defensively unwrap a `.rows`-shaped response too.
  if (Array.isArray(result)) return result as NameGroup[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: NameGroup[] }).rows;
  }
  return [];
};
