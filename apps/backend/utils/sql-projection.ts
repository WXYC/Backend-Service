import { sql, type Column, type SQL } from 'drizzle-orm';

/**
 * Emit `col AS "alias", …` from an alias → column projection map (BS#2231).
 *
 * Exists so a raw-SQL SELECT list can be generated from the same object a
 * Drizzle `.select()` takes, rather than hand-mirrored beside it. That pairing
 * is what makes a projection's completeness checkable: the object can be
 * constrained `satisfies Record<keyof TRow, Column | SQL>` so a field added to
 * the row type without a projection entry is a build error, and this function
 * carries that guarantee into the query shapes Drizzle's chained builder can't
 * express (UNION ALL branches, windowed subqueries) — which are otherwise
 * opaque to `tsc` and were where `artist_id` (BS#2228) and three `discogs_*`
 * columns (BS#1895) went missing.
 *
 * Aliases come from object keys, never from user input, and go through
 * `sql.identifier` so they are emitted double-quoted. Every alias in this
 * codebase is lowercase snake_case, so `AS "album_title"` is the same
 * identifier to Postgres as the unquoted form these projections used before —
 * unquoted references to them elsewhere in a query still resolve.
 *
 * Column ORDER is the object's insertion order. Two SELECTs combined by
 * `UNION ALL` match positionally, so branches that share one projection are
 * aligned by construction — which they were not when each branch carried its
 * own copy of the list.
 */
export function rawProjection(columns: Record<string, Column | SQL>): SQL {
  return sql.join(
    Object.entries(columns).map(([alias, column]) => sql`${column} AS ${sql.identifier(alias)}`),
    sql`, `
  );
}
