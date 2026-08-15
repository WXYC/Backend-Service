/**
 * Rotation read-path for jobs/uncovered-release-list (BS#1877, ADR 0013's
 * "uncovered-release list handoff").
 *
 * `fetchActiveRotationRows` reproduces the read-path documented for this
 * exact join (rotation × rotation_library_view, COALESCE'd): tubafrenzy
 * permits two shapes of active `rotation` row —
 *
 *   - album_id-linked: `album_id` is set, but the row's own `artist_name`/
 *     `album_title` snapshot columns are frequently NULL (the linked album's
 *     canonical strings live on `library`/`artists`, reached via
 *     `rotation_library_view`'s INNER JOIN on `rotation_id`).
 *   - snapshot-only: `album_id` is NULL (never linked to a library row);
 *     only the row's own `artist_name`/`album_title` snapshot is available.
 *
 * These are complementary, not either/or — a plain read of `rotation` alone
 * loses the linked rows' canonical strings, and reading only
 * `rotation_library_view` (an INNER JOIN) silently drops every snapshot-only
 * row (roughly half of active rotation, by current volume). The `LEFT JOIN`
 * + `COALESCE` below is the fix: it prefers the view's canonical fields when
 * a link exists, falls back to the row's own snapshot when it doesn't, and
 * keeps every active row in the result set either way.
 *
 * `resolveCanonicalRelease` is the second half: for an already-linked row,
 * `rotation_library_view`'s columns (`library.album_title` /
 * `artists.artist_name`) ARE the library-canonical pair — no further lookup
 * needed. For a snapshot-only row (no `album_id`), the row's own snapshot
 * text is a DJ/tubafrenzy-typed string, not necessarily library-canonical
 * — so it is resolved the SAME way `jobs/album-critic-reviews-etl/match.ts`
 * resolves a manifest item: `resolveLinkedAlbumId` (`@wxyc/database`), exact
 * match only, no fuzzy/pg_trgm. A resolve hit still needs its OWN canonical
 * fields fetched (the resolver returns only an id), via
 * `fetchCanonicalLibraryFields`. A miss drops the row — this job cannot
 * emit `uncovered-releases.jsonl`'s required `library_id: int` for a
 * release with no linked library row at all.
 */
import { sql } from 'drizzle-orm';
import { db, resolveLinkedAlbumId } from '@wxyc/database';
import { unwrapRows } from './db-utils.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ROTATION = sql.raw(`"${SCHEMA}"."rotation"`);
const ROTATION_LIBRARY_VIEW = sql.raw(`"${SCHEMA}"."rotation_library_view"`);
const LIBRARY = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS = sql.raw(`"${SCHEMA}"."artists"`);

/** One active `rotation` row, canonicalized field-for-field via the
 *  COALESCE join described above. `libraryId` is `null` for a snapshot-only
 *  row that has never been linked to a `library` row. */
export interface RotationRow {
  rotationId: number;
  libraryId: number | null;
  artistName: string;
  albumTitle: string;
}

/** A release resolved to a definite `library.id`, carrying the
 *  library-canonical `(artist, album)` pair — the exact triple
 *  `uncovered-releases.jsonl` rows are built from. */
export interface CanonicalRelease {
  libraryId: number;
  artist: string;
  album: string;
}

interface RawRotationRow {
  rotation_id: number;
  library_id: number | null;
  artist_name: string | null;
  album_title: string | null;
}

/**
 * Active rotation = `kill_date IS NULL OR kill_date > CURRENT_DATE` (the
 * same predicate `rotation_library_view` itself and every other rotation
 * read-path in this codebase use). Read-only; touches no other table.
 */
export const fetchActiveRotationRows = async (): Promise<RotationRow[]> => {
  const result: unknown = await db.execute(sql`
    SELECT
      r."id" AS rotation_id,
      COALESCE(v."library_id", r."album_id") AS library_id,
      COALESCE(v."artist_name", r."artist_name") AS artist_name,
      COALESCE(v."album_title", r."album_title") AS album_title
    FROM ${ROTATION} r
    LEFT JOIN ${ROTATION_LIBRARY_VIEW} v ON v."rotation_id" = r."id"
    WHERE r."kill_date" IS NULL OR r."kill_date" > CURRENT_DATE
  `);
  const rows = unwrapRows<RawRotationRow>(result);

  // Defensive: a row with neither the view's canonical strings nor its own
  // snapshot (should not exist given rotation's own NOT NULL-ish invariants
  // in steady state, but the table's header comment documents tubafrenzy
  // shapes this constrained-if-at-all) can't be resolved or emitted either
  // way — drop it here rather than propagate a null downstream.
  return rows
    .filter((row) => row.artist_name !== null && row.album_title !== null)
    .map((row) => ({
      rotationId: row.rotation_id,
      libraryId: row.library_id,
      artistName: row.artist_name as string,
      albumTitle: row.album_title as string,
    }));
};

interface RawCanonicalFields {
  library_id: number;
  album_title: string;
  artist_name: string;
}

/** Canonical `(artist, album)` for a KNOWN `library.id` — used both for a
 *  freshly `resolveLinkedAlbumId`-resolved snapshot-only row and could serve
 *  a future caller needing the same lookup. Joins `artists` (not
 *  `library.artist_name`'s denormalized column) so the canonical name
 *  matches exactly what `rotation_library_view` already uses for linked
 *  rows — one source of truth for "canonical artist string" across both
 *  code paths in this module. */
const fetchCanonicalLibraryFields = async (libraryId: number): Promise<CanonicalRelease | null> => {
  const result: unknown = await db.execute(sql`
    SELECT l."id" AS library_id, l."album_title" AS album_title, a."artist_name" AS artist_name
    FROM ${LIBRARY} l
    JOIN ${ARTISTS} a ON a."id" = l."artist_id"
    WHERE l."id" = ${libraryId}
  `);
  const rows = unwrapRows<RawCanonicalFields>(result);
  const row = rows[0];
  if (!row) return null;
  return { libraryId: row.library_id, artist: row.artist_name, album: row.album_title };
};

/**
 * Resolve one active rotation row to a `CanonicalRelease`, or `null` when it
 * can't be (no library link exists or is resolvable). See the module
 * docstring for the two-path rationale.
 */
export const resolveCanonicalRelease = async (row: RotationRow): Promise<CanonicalRelease | null> => {
  if (row.libraryId !== null) {
    // Already linked: rotation_library_view's COALESCE'd fields ARE the
    // library-canonical pair (see fetchActiveRotationRows) — no second
    // round trip needed.
    return { libraryId: row.libraryId, artist: row.artistName, album: row.albumTitle };
  }

  const resolvedId = await resolveLinkedAlbumId(row.artistName, row.albumTitle);
  if (resolvedId === null) return null;
  return fetchCanonicalLibraryFields(resolvedId);
};

/**
 * Collapse resolved releases to one row per `library.id`, dropping `null`s
 * (unresolved rows) and duplicates (tubafrenzy permits multiple active
 * rotation rows per release — re-bins, re-adds, label-driven re-promotes;
 * see `rotation`'s schema.ts header). First-wins is fine: every duplicate
 * resolves to the identical `CanonicalRelease` by construction (same
 * `library.id` -> same canonical fields), so pick order carries no meaning.
 */
export const dedupeByLibraryId = (releases: ReadonlyArray<CanonicalRelease | null>): CanonicalRelease[] => {
  const seen = new Map<number, CanonicalRelease>();
  for (const release of releases) {
    if (release === null) continue;
    if (!seen.has(release.libraryId)) seen.set(release.libraryId, release);
  }
  return [...seen.values()];
};
