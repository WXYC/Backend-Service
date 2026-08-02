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
 *
 * ## The postgres-js date-serializer trap (why not `${since}` and raw
 * timestamptz columns)
 *
 * `@wxyc/database`'s Drizzle client rebinds the postgres-js parsers AND
 * serializers for the date-family type OIDs (1184 timestamptz, ...) to a
 * transparent passthrough `(val) => val` (see drizzle-orm's postgres-js
 * `driver` + the `feedback_drizzle_date_serializer_override` note). That has
 * two consequences a raw `db.execute` must design around:
 *   - OUTBOUND: a JS `Date` bound via `${since}` is passed through unserialized
 *     into postgres-js's `Bind`, which then does `Buffer.byteLength(dateObj)`
 *     and throws `ERR_INVALID_ARG_TYPE`, surfacing only as the opaque
 *     `DrizzleQueryError: Failed query: ...` wrapper. So the `> :since` bound is
 *     pre-stringified: `${since.toISOString()}::timestamptz`.
 *   - INBOUND: timestamptz columns come back as raw PG text strings (the parser
 *     passthrough), not `Date`s. Rather than parse PG's default timestamptz text
 *     in JS, the three timestamps are selected as `extract(epoch from ...)`
 *     (float8 seconds -- an OID postgres-js parses to a real number) and
 *     rebuilt into `Date`s in the row mapper below.
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
 * The row shape `db.execute` actually returns for the SELECT below: the three
 * timestamps arrive as `extract(epoch from ...)` float8 seconds (a real JS
 * `number` -- postgres-js does NOT passthrough-override float8's parser), the
 * rest keep native postgres-js typing (int4 -> number, text -> string). Mapped
 * to `NoMatchRow` (epoch -> `Date`) in `queryNoMatchRows`.
 */
interface RawNoMatchRow {
  id: number;
  artist_name: string | null;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  rotation_id: number | null;
  album_id: number | null;
  dj_name: string | null;
  show_id: number | null;
  updated_at_epoch: number | string;
  add_time_epoch: number | string;
  start_time_epoch: number | string | null;
  show_name: string | null;
}

/**
 * `extract(epoch from ts)` is seconds-since-epoch (float8); `* 1000` -> ms for
 * the `Date` ctor. `Number(...)` also copes if a driver/version returns it as a
 * string. NULL (nullable `shows.start_time` via the LEFT JOIN) -> `null`.
 * Minute-granularity rendering (`format.ts`) makes any sub-second float error
 * irrelevant.
 */
const epochToDate = (epochSeconds: number | string | null): Date | null =>
  epochSeconds == null ? null : new Date(Number(epochSeconds) * 1000);

/** As `epochToDate`, for the two NOT NULL timestamp columns (never null-epoch). */
const epochToDateStrict = (epochSeconds: number | string): Date => new Date(Number(epochSeconds) * 1000);

/**
 * Rows that flipped to `enriched_no_match` strictly after `since`
 * (exclusive -- matches the watermark's `> :last_run` semantics) AND whose
 * play itself is recent (`add_time > playAgeCutoff`), newest
 * rotation/catalog-linked rows first (`rotation_id IS NOT NULL` sorts
 * ahead of freeform), then newest-first within each group, capped at
 * `MAX_DIGEST_ROWS`. Restricted to `entry_type = 'track'`: only track rows
 * are ever enriched (markers/messages stay `pending`), but the explicit
 * predicate hardens against a stray non-track row surfacing.
 *
 * Two independent bounds, not one: `since` (the watermark) still catches a
 * row newly *flipped* to no-match, while `playAgeCutoff` requires the play
 * itself to be recent. Without the second bound, a backfill re-touching old
 * plays (old `add_time`, fresh `updated_at` -- the `bump_flowsheet_updated_at`
 * trigger fires on every write) floods the digest with historical rows that
 * aren't new. See `watermark.ts`'s `resolvePlayAgeCutoff` / BS#1921.
 *
 * `since` and `playAgeCutoff` are both pre-stringified and the timestamps are
 * selected as epoch to sidestep the postgres-js date-serializer/parser
 * passthrough -- see the file header.
 */
export const queryNoMatchRows = async (since: Date, playAgeCutoff: Date): Promise<NoMatchRow[]> => {
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
      extract(epoch from f."updated_at") AS "updated_at_epoch",
      extract(epoch from f."add_time") AS "add_time_epoch",
      extract(epoch from s."start_time") AS "start_time_epoch",
      s."show_name" AS "show_name"
    FROM ${FLOWSHEET_TABLE} f
    LEFT JOIN ${SHOWS_TABLE} s ON s."id" = f."show_id"
    WHERE f."metadata_status" = 'enriched_no_match'
      AND f."entry_type" = 'track'
      AND f."updated_at" > ${since.toISOString()}::timestamptz
      AND f."add_time" > ${playAgeCutoff.toISOString()}::timestamptz
    ORDER BY (f."rotation_id" IS NOT NULL) DESC, f."updated_at" DESC
    LIMIT ${MAX_DIGEST_ROWS}
  `;
  const raw = unwrapRows<RawNoMatchRow>(await db.execute(query));
  return raw.map((r) => ({
    id: r.id,
    artist_name: r.artist_name,
    track_title: r.track_title,
    album_title: r.album_title,
    record_label: r.record_label,
    rotation_id: r.rotation_id,
    album_id: r.album_id,
    dj_name: r.dj_name,
    show_id: r.show_id,
    // updated_at / add_time are NOT NULL columns; start_time is nullable
    // (the LEFT JOIN can miss).
    updated_at: epochToDateStrict(r.updated_at_epoch),
    add_time: epochToDateStrict(r.add_time_epoch),
    show_name: r.show_name,
    start_time: epochToDate(r.start_time_epoch),
  }));
};
