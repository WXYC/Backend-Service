/**
 * The catalog-popularity-freetext-resolve ENUMERATE statement (BS#1767 /
 * BS#1799 — extracted to `@wxyc/database` from
 * `jobs/catalog-popularity-freetext-resolve/job.ts` so it is a single
 * importable source of truth for both the job's TS runtime and the
 * `tests/integration` babel-jest harness, which can't import the job
 * directly (no TS transform registered for `jest.config.json`; see BS#1799).
 *
 * `jobs/catalog-popularity-freetext-resolve/job.ts` is now a thin re-export
 * shim pointing here (à la the `@wxyc/legacy-mirror` BS#1707 extraction and
 * `jobs/concerts-artist-resolver/recompute.ts`'s BS#1763 shim), so its
 * existing import site stays untouched.
 *
 * SELECT one row per unlinked `(artist, album)` pair, carrying the pair's
 * MOST-PLAYED non-empty `track_title` as its representative track.
 *
 * The most-played track (not the alphabetically-first) is the album's
 * canonical track — an 'A…' bonus/intro title is an arbitrary, low-signal
 * representative that resolves to the wrong release (or no release) far more
 * often. Picking the modal track reduces both wrong-release matches and missed
 * matches; the A/B probe behind BS#1767 showed track-aware matching lifting the
 * match rate ~3.7x over album-only with zero regressions.
 *
 * Shape: an inner `GROUP BY (artist_name, album_title, track_title)` counts
 * plays per distinct track, then `DISTINCT ON (artist_name, album_title)` with
 * an `ORDER BY` that (1) prefers a non-empty track
 * (`btrim(coalesce(track_title, '')) = ''` sorts false-before-true, so
 * non-empty first), (2) then most-played (`play_count DESC`), (3) then a
 * deterministic `track_title ASC` tiebreak, keeps exactly the modal
 * representative per pair. Cardinality is UNCHANGED — still one row per
 * distinct `(artist, album)` pair; the GROUP BY only picks a better
 * representative track, it does not change which pairs are enumerated. There is
 * NO `track_title IS NOT NULL` filter — a pair whose plays are all track-less
 * still enumerates and resolves album-only, exactly as before this change.
 *
 * The `normalizePairs` determinism contract (in the job) still holds: rows
 * remain ordered by `(artist_name, album_title)` first, so the
 * first-encountered representative per normalized key is stable across runs.
 *
 * The inner GROUP BY subquery measured ~17s on prod (within the raised
 * `statement_timeout`). Wrapped in `db.transaction` + `SET LOCAL
 * statement_timeout` because the `album_id IS NULL` partition isn't covered by
 * the metadata-drain partial indexes; the planner falls back to a scan that can
 * exceed the backend's default `statement_timeout`. `SET LOCAL` only scopes
 * inside an explicit transaction with the postgres-js driver. Mirrors
 * `album-level-backfill#enumeratePendingAlbumIds`.
 */

import { sql } from 'drizzle-orm';
import { db } from './client.js';

/** A raw free-text pair as the DJ typed it, with a representative track title.
 * `song` is trimmed at the enumerate boundary (empty string when no usable
 * track exists for the pair) — it is the single place the "usable track?" rule
 * is applied, so every downstream consumer can treat a truthy `song` as ready
 * to send. */
export interface RawPair {
  artist: string;
  album: string;
  song: string;
}

/** Default statement timeout (ms) for the enumerate scan when the caller
 * doesn't pass one explicitly. Mirrors
 * `jobs/catalog-popularity-freetext-resolve/job.ts`'s
 * `READ_TIMEOUT_DEFAULT` (5 minutes) — kept as a separate literal here since
 * that job's constant is env-var-driven (`FREETEXT_RESOLVE_READ_TIMEOUT_MS`)
 * and this default only matters for a bare no-arg call (unit tests). */
const DEFAULT_READ_TIMEOUT_MS = 5 * 60 * 1000;

export const enumerateFreetextPairs = async (timeoutMs: number = DEFAULT_READ_TIMEOUT_MS): Promise<RawPair[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON ("artist_name", "album_title")
             "artist_name", "album_title", "track_title"
      FROM (
        SELECT "artist_name", "album_title", "track_title", count(*) AS play_count
        FROM "wxyc_schema"."flowsheet"
        WHERE "entry_type" = 'track'
          AND "album_id" IS NULL
          AND "artist_name" IS NOT NULL
          AND "album_title" IS NOT NULL
        GROUP BY "artist_name", "album_title", "track_title"
      ) g
      ORDER BY "artist_name", "album_title",
               (btrim(coalesce("track_title", '')) = '') ASC,
               play_count DESC,
               "track_title" ASC
    `)) as unknown as Array<{ artist_name: string; album_title: string; track_title: string | null }>;
    return rows.map((r) => ({
      artist: String(r.artist_name),
      album: String(r.album_title),
      // Trim the representative track once, HERE, at the single "usable track?"
      // boundary. Downstream (`buildBulkItems`) treats a truthy `song` as
      // ready-to-send with no further trimming.
      song: (r.track_title ?? '').trim(),
    }));
  });
};
