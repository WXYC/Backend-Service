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
import {
  db,
  library,
  artists,
  format,
  genres,
  genre_artist_crossreference,
  artist_crossreference,
  compilation_track_artist,
  rotation,
  album_plays,
  album_popularity,
} from '@wxyc/database';
import { createWatermarkCache } from './watermark-cache.service.js';
import { getCatalogLastModifiedAt } from './library.service.js';
import { logicalAlbumKeySql } from './logical-album-key.service.js';

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
  legacy_release_id: number;
  artist_name: string;
  alternate_artist_name: string | null;
  album_artist: string | null;
  cross_reference_names: string | null;
  album_title: string;
  code_letters: string;
  code_number: number;
  code_artist_number: number;
  label: string | null;
  genre_name: string;
  format_name: string;
  on_streaming: boolean | null;
  plays: number | null;
  popularity: number | null;
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
  legacy_release_id: row.legacy_release_id,
  artist_name: row.artist_name,
  alternate_artist_name: row.alternate_artist_name,
  album_artist: row.album_artist,
  cross_reference_names: row.cross_reference_names,
  album_title: row.album_title,
  code_letters: row.code_letters,
  code_number: row.code_number,
  code_artist_number: row.code_artist_number,
  label: row.label,
  genre_name: row.genre_name,
  format_name: row.format_name,
  on_streaming: row.on_streaming,
  plays: row.plays,
  popularity: row.popularity,
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
 * 5-table join, with three deliberate divergences for the export contract:
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
 *  - `artist_name` prefers the denormalized `library.artist_name` (physical
 *    column kept current by the 0060 cascade) but COALESCEs to the authoritative
 *    `artists.artist_name` (NOT NULL) — `library.artist_name` is nullable
 *    ("Nullable until A.2") and the export contract types `artist_name` non-null,
 *    so an un-backfilled NULL must not ship as JSON null and break generated
 *    iOS/Kotlin decoders. Both source columns advance the watermark (library
 *    trigger + the 0105 artists trigger), so the COALESCE stays freshness-correct.
 *  - `plays` comes from the `album_plays` materialized view (migration 0059,
 *    refreshed hourly by `album-plays-refresh.service.ts`), NOT the
 *    `library_artist_view.plays` passthrough of the physical `library.plays`
 *    column. `library.plays` is a dead counter — nothing maintains it (the
 *    flowsheet add/delete increments are commented out), so it is `0` for every
 *    row and shipped a no-signal field (BS#1486). `album_plays` is the live
 *    per-album `COUNT(*)` over `flowsheet` track entries, LEFT JOINed and
 *    COALESCEd to `0` so unplayed albums ship `0` (never JSON null). Two known
 *    limitations, tracked as the Phase-2 attribution epic (BS#1486): (1) it
 *    counts only flowsheet rows with a non-null `album_id` FK — ~43% of music
 *    plays are free-text/unlinked and invisible here; (2) it is keyed per
 *    `library.id` (per pressing/format), so the same logical album split across
 *    multiple `library` rows is NOT collapsed. Freshness: `album_plays` refreshes
 *    on its own timer and does not advance `library_watermark`, so a play-count
 *    change surfaces in the export only once the next library/parent write bumps
 *    the watermark and rebuilds the cache below — acceptable day-scale lag for a
 *    slow-moving popularity signal.
 *  - `popularity` is the attribution-corrected logical-album signal from the
 *    `album_popularity` table (BS#1486 Phase-2 Track 2, refreshed by
 *    `album-popularity-refresh.service.ts`), addressing both `plays` limitations
 *    above: it collapses the pressings sharing one Discogs master and folds in
 *    the Track-1-resolved free-text plays. LEFT JOINed by the row's logical key —
 *    the `discogs:`-stripped `canonical_entity_id` (`discogs:master:<id>` ->
 *    `master:<id>`), the value verbatim for any other non-null scheme, else
 *    `library:<id>`. The derivation is the shared `logicalAlbumKeySql` fragment
 *    (`logical-album-key.service.ts`), the SAME builder the rebuild groups on, so the
 *    reader and writer keys cannot drift (a divergence would silently null
 *    popularity; the pg integration spec + `logical-album-key.service.test.ts`
 *    guard it).
 *    Unlike `plays`, it is projected RAW (nullable, NOT COALESCEd to 0): `null`
 *    means the logical album has no plays at all (linked or free-text), per the
 *    merged SSOT contract. Same watermark-lag caveat as `plays` (the refresh does
 *    not advance `library_watermark`).
 *  - the four BS#1965 library.db-producer fields: `legacy_release_id`,
 *    `alternate_artist_name`, and `album_artist` are raw `library` columns;
 *    `cross_reference_names` is the pipe-joined artist-alias string from the
 *    `artist_aliases` CTE (see its inline comment). These feed the Backend-sourced
 *    `library.db` producer (discogs-etl#351) — `legacy_release_id` becomes
 *    library.db's `library.id`. `cross_reference_names` rides `library_watermark`
 *    freshness like `plays`/`popularity`: an `artist_crossreference` edit surfaces
 *    only on the next watermark-advancing write — acceptable day-scale lag for the
 *    daily producer.
 *
 * One scan per watermark (cached below), so the full-table cost is paid ~daily.
 */
export const getCatalogExportRows = async (): Promise<CatalogExportRow[]> => {
  const rows = await db.execute(sql`
    WITH artist_aliases AS (
      -- Per-artist alias aggregation for cross_reference_names (BS#1965,
      -- discogs-etl#334). UNION folds artist_crossreference in BOTH FK directions
      -- into (artist_id, other_id) pairs so a row filed under either endpoint
      -- surfaces the other; string_agg DISTINCT ... ORDER BY yields a stable,
      -- deduplicated, alphabetically-ordered pipe-joined string — the deterministic
      -- analogue of the legacy MySQL GROUP_CONCAT(DISTINCT ... SEPARATOR ' | ').
      -- O(crossref rows), joined once per artist, NOT a per-library correlated scan.
      SELECT cp.artist_id AS artist_id,
             string_agg(DISTINCT ${artists.artist_name}, ' | ' ORDER BY ${artists.artist_name})
               AS cross_reference_names
      FROM (
        SELECT ${artist_crossreference.source_artist_id} AS artist_id,
               ${artist_crossreference.target_artist_id} AS other_id
        FROM ${artist_crossreference}
        UNION
        SELECT ${artist_crossreference.target_artist_id} AS artist_id,
               ${artist_crossreference.source_artist_id} AS other_id
        FROM ${artist_crossreference}
      ) cp
        INNER JOIN ${artists} ON ${artists.id} = cp.other_id
      WHERE cp.other_id <> cp.artist_id
      GROUP BY cp.artist_id
    )
    SELECT DISTINCT ON (${library.id})
      ${library.id}                            AS id,
      ${library.legacy_release_id}             AS legacy_release_id,
      COALESCE(${library.artist_name}, ${artists.artist_name}) AS artist_name,
      ${library.alternate_artist_name}         AS alternate_artist_name,
      ${library.album_artist}                  AS album_artist,
      artist_aliases.cross_reference_names     AS cross_reference_names,
      ${library.album_title}                   AS album_title,
      ${artists.code_letters}                  AS code_letters,
      ${library.code_number}                   AS code_number,
      ${genre_artist_crossreference.artist_genre_code} AS code_artist_number,
      ${library.label}                         AS label,
      ${genres.genre_name}                     AS genre_name,
      ${format.format_name}                    AS format_name,
      ${library.on_streaming}                  AS on_streaming,
      COALESCE(${album_plays.plays}, 0)::int   AS plays,
      ${album_popularity.plays}::int           AS popularity,
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
      LEFT JOIN artist_aliases ON artist_aliases.artist_id = ${library.artist_id}
      LEFT JOIN ${rotation} ON ${rotation.album_id} = ${library.id}
      LEFT JOIN ${album_plays} ON ${album_plays.album_id} = ${library.id}
      LEFT JOIN ${album_popularity} ON ${album_popularity.logical_album_key} = ${logicalAlbumKeySql(
        library.canonical_entity_id,
        library.id
      )}
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

// ---------------------------------------------------------------------------
// Compilation-track (CTA) export (BS#1965) — sibling of the catalog export
// ---------------------------------------------------------------------------

/**
 * One compilation_track_artist row as exported to the library.db producer
 * (BS#1965 / discogs-etl#351). Feeds library.db's `compilation_track_artist`
 * table (3 columns), the sibling of the `library` table that `CatalogExportRow`
 * feeds. Keyed on `legacy_release_id` — the owning library row's surrogate key,
 * which `CatalogExportRow` also emits AS library.db's `library.id` — so the
 * producer maps `legacy_release_id` -> `compilation_track_artist.library_release_id`.
 * Deliberately drops the CTA row `id` + `track_position`: library.db's 3-column
 * CTA table carries neither.
 */
export type CompilationTrackExportRow = {
  legacy_release_id: number;
  artist_name: string;
  track_title: string | null;
};

/**
 * Project to exactly the CTA export contract fields, in a fixed key order.
 * Explicit projection (not a passthrough) so the CTA row `id`, the serial
 * `library_id`, or `track_position` can never leak into the produced library.db.
 */
const projectCompilationTrackRow = (row: CompilationTrackExportRow): CompilationTrackExportRow => ({
  legacy_release_id: row.legacy_release_id,
  artist_name: row.artist_name,
  track_title: row.track_title,
});

/**
 * Serialize CTA export rows to NDJSON (one JSON object per line). Empty input
 * yields an empty string (no trailing newline to mis-parse as a row).
 */
export const serializeCompilationTracksNdjson = (rows: CompilationTrackExportRow[]): string =>
  rows.map((row) => JSON.stringify(projectCompilationTrackRow(row))).join('\n');

/**
 * Read every compilation_track_artist row as flat export rows, keyed on the
 * owning library row's `legacy_release_id` (NOT the serial CTA `library_id`).
 * INNER JOIN to `library` because `compilation_track_artist.library_id` is a
 * NOT-NULL cascade FK, so every CTA row has exactly one library parent with a
 * (now total, BS#1963) `legacy_release_id`. Ordered by `legacy_release_id` (then
 * CTA `id` for a stable tiebreak), matching the legacy MySQL export's
 * `ORDER BY LIBRARY_RELEASE_ID`.
 *
 * One scan per watermark (cached below). CTA freshness rides `library_watermark`
 * (see the endpoint docblock): a new compilation's rows surface as soon as its
 * library add advances the watermark; a standalone CTA edit lags to the next
 * library write — acceptable day-scale lag for the daily producer.
 */
export const getCompilationTrackExportRows = async (): Promise<CompilationTrackExportRow[]> => {
  const rows = await db.execute(sql`
    SELECT
      ${library.legacy_release_id}             AS legacy_release_id,
      ${compilation_track_artist.artist_name}  AS artist_name,
      ${compilation_track_artist.track_title}  AS track_title
    FROM ${compilation_track_artist}
      INNER JOIN ${library} ON ${library.id} = ${compilation_track_artist.library_id}
    ORDER BY ${library.legacy_release_id} ASC, ${compilation_track_artist.id} ASC
  `);
  return rows as unknown as CompilationTrackExportRow[];
};

/**
 * Build the gzipped NDJSON CTA payload from a fresh scan.
 */
const buildCompilationTracksExportGzip = async (): Promise<Buffer> => {
  const rows = await getCompilationTrackExportRows();
  return gzipSync(Buffer.from(serializeCompilationTracksNdjson(rows), 'utf8'));
};

// One shared gzipped copy per pod, rebuilt only when the catalog watermark
// advances (≈daily) — same watermark as the library export, so the two exports
// the producer fetches together stay a consistent snapshot.
const compilationTracksExportCache = createWatermarkCache<Buffer>(
  getCatalogLastModifiedAt,
  buildCompilationTracksExportGzip
);

/**
 * The gzipped NDJSON CTA export for the current watermark. Served as-is on the
 * gzip-accepting path; gunzipped by the controller for the rare client that
 * doesn't accept gzip.
 */
export const getCompilationTracksExportGzip = (): Promise<Buffer> => compilationTracksExportCache.get();
