/**
 * The digest query: `flowsheet` rows that became `metadata_status =
 * 'enriched_no_match'` since the watermark.
 *
 * Filters and sorts on `flowsheet.updated_at` -- NEVER `metadata_attempt_at`.
 * The live CDC enrichment worker (`apps/enrichment-worker`) deliberately
 * leaves `metadata_attempt_at` NULL on `enriched_no_match` rows (see
 * `shared/database/src/schema.ts` on that column), so filtering on it would
 * surface almost nothing. `updated_at` is bumped by the
 * `bump_flowsheet_updated_at` trigger (migration 0084) on every write,
 * including the worker's status-flip UPDATE, and is served by the
 * `flowsheet_updated_at_idx` DESC index for the `> :last_run` bound.
 *
 * Schema-qualified via `WXYC_SCHEMA_NAME` (never hardcoded `wxyc_schema.`)
 * so parallel Jest workers on per-schema DBs don't collide -- mirrors
 * `jobs/flowsheet-ghost-row-sweep/orchestrate.ts` and
 * `jobs/flowsheet-metadata-backfill/worklist.ts`.
 */
import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const SHOWS_TABLE = sql.raw(`"${SCHEMA}"."shows"`);

export interface NoMatchRow {
  id: number;
  artist_name: string | null;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  rotation_id: number | null;
  album_id: number | null;
  dj_name: string | null;
  show_id: number | null;
  updated_at: Date;
  add_time: Date;
  show_name: string | null;
  start_time: Date | null;
}

/**
 * Rows that flipped to `enriched_no_match` strictly after `since`
 * (exclusive -- matches the watermark's `> :last_run` semantics), newest
 * rotation/catalog-linked rows first (`rotation_id IS NOT NULL` sorts
 * ahead of freeform), then newest-first within each group.
 */
export const queryNoMatchRows = async (since: Date): Promise<NoMatchRow[]> => {
  const query = sql`
    SELECT
      f."id" AS "id",
      f."artist_name" AS "artist_name",
      f."track_title" AS "track_title",
      f."album_title" AS "album_title",
      f."record_label" AS "record_label",
      f."rotation_id" AS "rotation_id",
      f."album_id" AS "album_id",
      f."dj_name" AS "dj_name",
      f."show_id" AS "show_id",
      f."updated_at" AS "updated_at",
      f."add_time" AS "add_time",
      s."show_name" AS "show_name",
      s."start_time" AS "start_time"
    FROM ${FLOWSHEET_TABLE} f
    LEFT JOIN ${SHOWS_TABLE} s ON s."id" = f."show_id"
    WHERE f."metadata_status" = 'enriched_no_match'
      AND f."updated_at" > ${since}
    ORDER BY (f."rotation_id" IS NOT NULL) DESC, f."updated_at" DESC
  `;
  const rows = (await db.execute(query)) as unknown as NoMatchRow[];
  return rows ?? [];
};
