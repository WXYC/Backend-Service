/**
 * Multi-match tie-break utility (B-2.3).
 *
 * When LML resolves a flowsheet entry to a canonical entity that maps to
 * more than one library row (the same release stocked on multiple formats,
 * typically vinyl + CD), pick a single primary library row to link to.
 * Both the forward path (B-2.1) and the backfill (B-2.2) call into this
 * helper so they agree on a deterministic choice.
 *
 * Tie-break order (issue #500):
 *   1. Currently in rotation — `rotation.kill_date` IS NULL OR > today.
 *   2. Format priority — vinyl > CD/CDR > digital > unknown.
 *   3. Higher play count — read from the `album_plays` materialized view
 *      (Epic A.5/A.6).
 *   4. Lower `library.id` — deterministic fallback so retries pick the
 *      same row when nothing else differentiates.
 *
 * The whole tie-break is one round-trip: an EXISTS subquery over
 * `rotation` for the rotation flag, a LEFT JOIN to `format` for the
 * format-name ranking, and a LEFT JOIN to `album_plays` for the
 * play-weight signal. Postgres applies the ORDER BY against the bounded
 * candidate set, then `LIMIT 1` returns the winner.
 *
 * Format-name matching is prefix-based on `'vinyl%'` because WXYC's
 * catalog stores size variants (`vinyl 7"`, `vinyl 12"`, `vinyl 10"`)
 * alongside the bare `vinyl` value.
 *
 * Aggregation note: by design, plays are read at the `library.id` level,
 * not aggregated across the canonical entity (see issue #500's "Open
 * question: resolution"). A canonical-level aggregation would still need
 * a tie-break to pick which library row to return, so it doesn't simplify
 * this code — and per-library_id matches the current return shape that
 * `flowsheet.album_id` is constrained to.
 */
import { sql } from 'drizzle-orm';
import { db } from './client.js';

export const pickPrimaryLibraryRow = async (libraryIds: number[]): Promise<number | null> => {
  if (libraryIds.length === 0) return null;
  if (libraryIds.length === 1) return libraryIds[0];

  // Bind as a single PG-array-literal string param (`'{10,11,12}'::int[]`)
  // rather than the bare `${libraryIds}`. Drizzle/postgres-js splats a JS
  // array into N positional placeholders here — both `ANY(${array}::int[])`
  // and the bare `ANY(${array})` send `ANY(($1, $2, …))` over the wire,
  // which PG rejects at arity >= 2 with "op ANY/ALL (array) requires array
  // on right side" (BS#1071) or "cannot cast type record to integer[]"
  // (BS#1068). See jobs/album-level-backfill/job.ts's `resolveAlbums` for
  // the same fix (BS#1072).
  //
  // Safe by construction: TypeScript types `libraryIds: number[]`, so the
  // join contains only numeric literals — no injection surface.
  const idArrayLiteral = `{${libraryIds.join(',')}}`;

  const rows = (await db.execute(sql`
    SELECT l."id"
    FROM "wxyc_schema"."library" l
    LEFT JOIN "wxyc_schema"."format" f ON f."id" = l."format_id"
    LEFT JOIN "wxyc_schema"."album_plays" ap ON ap."album_id" = l."id"
    WHERE l."id" = ANY(${idArrayLiteral}::int[])
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1
        FROM "wxyc_schema"."rotation" r
        WHERE r."album_id" = l."id"
          AND (r."kill_date" IS NULL OR r."kill_date" > CURRENT_DATE)
      ) THEN 1 ELSE 0 END DESC,
      CASE
        WHEN f."format_name" ILIKE 'vinyl%' THEN 4
        WHEN f."format_name" IN ('cd', 'cdr') THEN 3
        WHEN f."format_name" ILIKE 'digital%' THEN 2
        ELSE 1
      END DESC,
      COALESCE(ap."plays", 0) DESC,
      l."id" ASC
    LIMIT 1
  `)) as unknown as Array<{ id: number }>;

  return rows?.[0]?.id ?? null;
};
