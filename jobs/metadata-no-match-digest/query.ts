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

/**
 * Hard cap on rows loaded (and thus on the email's size). Not a normal-day
 * limit -- daily volume is far below this -- but a backstop: if the watermark
 * ever stalls (repeated send failures, or the cron down for a long stretch)
 * the window would otherwise grow without bound and eventually build an email
 * past SES's size limit, whose send-failure would then never advance the
 * watermark, permanently stuck rebuilding the same too-big email. The
 * `ORDER BY (rotation_id IS NOT NULL) DESC` means a truncated run still keeps
 * the actionable rotation-linked rows. `format.ts` further caps Section A's
 * rendered lines and reports the cap in the header.
 */
export const MAX_DIGEST_ROWS = 5000;

/**
 * postgres-js `db.execute` returns a bare `RowList` array today; guard the
 * shape so a future drizzle/driver change that wraps it as `{ rows: [...] }`
 * crashes loudly rather than surfacing an opaque `rows.filter is not a
 * function` -- and never silently drains zero. Mirrors the fleet-wide
 * `unwrapRows` helper (e.g. `jobs/flowsheet-metadata-backfill/worklist.ts`).
 */
const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error('metadata-no-match-digest: unrecognized db.execute() result shape');
};

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
 * ahead of freeform), then newest-first within each group, capped at
 * `MAX_DIGEST_ROWS`. Restricted to `entry_type = 'track'`: only track rows
 * are ever enriched (markers/messages stay `pending`), but the explicit
 * predicate hardens against a stray non-track row surfacing.
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
      AND f."entry_type" = 'track'
      AND f."updated_at" > ${since}
    ORDER BY (f."rotation_id" IS NOT NULL) DESC, f."updated_at" DESC
    LIMIT ${MAX_DIGEST_ROWS}
  `;
  return unwrapRows<NoMatchRow>(await db.execute(query));
};
