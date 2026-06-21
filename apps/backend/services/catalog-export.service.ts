/**
 * Bulk catalog export (BS#1468, Epic F pattern — parent #1466).
 *
 * Serves the entire `library` catalog as one gzipped NDJSON response so the
 * `wxyc-dj-ios` app can clone it on-device and index it into Core Spotlight,
 * instead of paging ~500 capped `GET /library/query` requests. The response is
 * gated by the `conditionalGet(getCatalogLastModifiedAt)` middleware (BS#1467),
 * so a client that has already cloned the catalog gets a cheap `304` until the
 * `library_watermark` advances.
 *
 * This module owns the wire shape (`CatalogExportRow` + NDJSON serialization),
 * the DB read, and the per-watermark gzip cache.
 */

import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { db, library, artists, format, genres, genre_artist_crossreference, rotation } from '@wxyc/database';
import { createWatermarkCache } from './watermark-cache.service.js';
import { getCatalogLastModifiedAt } from './library.service.js';

/**
 * One catalog row as exported to the client. Flat projection over the
 * `library_artist_view` join (BS#1466), minus `search_doc` (server-side search
 * artifact, not useful on-device).
 *
 * `rotation_bin` + `rotation_kill_date` are exported **raw** (the most-recent
 * rotation record per album), NOT the view's `CURRENT_DATE`-filtered
 * `rotation_bin`: the daily `kill_date` expiry is a pure clock event no
 * statement trigger can observe, so the client evaluates "in rotation" against
 * its own clock as `rotation_bin != null && (rotation_kill_date == null ||
 * rotation_kill_date > today_local)`. See #1468 "Payload & freshness".
 */
export type CatalogExportRow = {
  id: number;
  artist_name: string;
  album_title: string;
  code_letters: string;
  code_number: number;
  code_artist_number: number;
  label: string | null;
  genre_name: string;
  format_name: string;
  on_streaming: boolean | null;
  plays: number | null;
  artwork_url: string | null;
  rotation_bin: string | null;
  rotation_kill_date: string | null;
};

/**
 * Project a (possibly wider) row to exactly the export contract fields, in a
 * fixed key order. Explicit projection — not a passthrough `JSON.stringify` —
 * so a server-only column on the source row (e.g. `search_doc`,
 * `alphabetical_name`) can never leak into the on-device clone.
 */
const projectRow = (row: CatalogExportRow): CatalogExportRow => ({
  id: row.id,
  artist_name: row.artist_name,
  album_title: row.album_title,
  code_letters: row.code_letters,
  code_number: row.code_number,
  code_artist_number: row.code_artist_number,
  label: row.label,
  genre_name: row.genre_name,
  format_name: row.format_name,
  on_streaming: row.on_streaming,
  plays: row.plays,
  artwork_url: row.artwork_url,
  rotation_bin: row.rotation_bin,
  rotation_kill_date: row.rotation_kill_date,
});

/**
 * Serialize catalog rows to NDJSON: one JSON object per line, newline-separated.
 * Friendlier than a framed array to build and parse incrementally. An empty
 * input yields an empty string (no trailing newline to mis-parse as a row).
 */
export const serializeCatalogNdjson = (rows: CatalogExportRow[]): string =>
  rows.map((row) => JSON.stringify(projectRow(row))).join('\n');

/**
 * Read the full catalog as flat export rows. Mirrors `library_artist_view`'s
 * 5-table join, with two deliberate divergences for the export contract:
 *
 *  - rotation is joined RAW (no `kill_date > CURRENT_DATE` filter) and we keep
 *    the most-recently-ADDED rotation record per album (`DISTINCT ON
 *    (library.id) ORDER BY library.id, rotation.add_date DESC, rotation.id
 *    DESC`). Ordering by `add_date`, NOT `id`: an album can carry an old killed
 *    record with a *higher* serial id than its current active record (re-adds
 *    insert fresh rows), so `id DESC` would surface the stale killed row and the
 *    client would wrongly read the album as out of rotation. `id DESC` is only
 *    the same-day tiebreak. The view's `CURRENT_DATE` filter is a server-side
 *    day-floor; the export ships raw `rotation_bin` + `rotation_kill_date` so
 *    the client evaluates expiry against its own clock. `kill_date` is cast to
 *    text so it serializes as a stable `YYYY-MM-DD` string (or null), not a
 *    parser-dependent Date.
 *  - `artist_name` reads the denormalized `library.artist_name` (physical
 *    column kept current by the 0060 cascade) rather than the `artists` join.
 *
 * One scan per watermark (cached below), so the full-table cost is paid ~daily.
 */
export const getCatalogExportRows = async (): Promise<CatalogExportRow[]> => {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (${library.id})
      ${library.id}                            AS id,
      ${library.artist_name}                   AS artist_name,
      ${library.album_title}                   AS album_title,
      ${artists.code_letters}                  AS code_letters,
      ${library.code_number}                   AS code_number,
      ${genre_artist_crossreference.artist_genre_code} AS code_artist_number,
      ${library.label}                         AS label,
      ${genres.genre_name}                     AS genre_name,
      ${format.format_name}                    AS format_name,
      ${library.on_streaming}                  AS on_streaming,
      ${library.plays}                         AS plays,
      ${library.artwork_url}                   AS artwork_url,
      ${rotation.rotation_bin}                 AS rotation_bin,
      ${rotation.kill_date}::text              AS rotation_kill_date
    FROM ${library}
      INNER JOIN ${artists} ON ${artists.id} = ${library.artist_id}
      INNER JOIN ${format} ON ${format.id} = ${library.format_id}
      INNER JOIN ${genres} ON ${genres.id} = ${library.genre_id}
      INNER JOIN ${genre_artist_crossreference}
        ON ${genre_artist_crossreference.artist_id} = ${library.artist_id}
       AND ${genre_artist_crossreference.genre_id} = ${library.genre_id}
      LEFT JOIN ${rotation} ON ${rotation.album_id} = ${library.id}
    ORDER BY ${library.id}, ${rotation.add_date} DESC, ${rotation.id} DESC
  `);
  return rows as unknown as CatalogExportRow[];
};

/**
 * Build the gzipped NDJSON payload from a fresh full-catalog scan.
 */
const buildCatalogExportGzip = async (): Promise<Buffer> => {
  const rows = await getCatalogExportRows();
  return gzipSync(Buffer.from(serializeCatalogNdjson(rows), 'utf8'));
};

// One shared gzipped copy per pod, rebuilt only when the catalog watermark
// advances (≈daily). Keeps the hot path a memcpy instead of a 5-join scan +
// re-gzip, and makes delivery atomic (no torn body, correct Content-Length).
const catalogExportCache = createWatermarkCache<Buffer>(getCatalogLastModifiedAt, buildCatalogExportGzip);

/**
 * The gzipped NDJSON catalog export for the current watermark. Served as-is on
 * the gzip-accepting path; gunzipped by the controller for the rare client that
 * doesn't accept gzip.
 */
export const getCatalogExportGzip = (): Promise<Buffer> => catalogExportCache.get();
