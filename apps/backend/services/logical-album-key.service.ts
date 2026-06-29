/**
 * The single canonical definition of the Phase-2 catalog-popularity
 * *logical-album key* (BS#1486 / #1505) — the `master:<id>` / `release:<id>` /
 * `library:<id>` string that collapses every pressing/format of one album into a
 * single popularity count.
 *
 * The key is derived in two equivalent forms that MUST agree, or the
 * `GET /library/catalog` LEFT JOIN onto `album_popularity` silently nulls
 * `popularity`. `popularity` is deliberately nullable (null = "no logical
 * signal"), so a drift between the forms is indistinguishable from a
 * legitimately-absent signal: no error, no failing type, just a quietly-wrong
 * column. Before #1505 the SQL form was hand-written in two byte-identical spots
 * (the reader JOIN and the writer GROUP BY); this module collapses them to one.
 *
 *   - `logicalAlbumKeySql` — the SQL form over `library.canonical_entity_id`,
 *     consumed by BOTH the reader (`catalog-export.service.ts` export JOIN) and
 *     the writer (`album-popularity-refresh.service.ts` linked-leg GROUP BY).
 *     ONE builder, two callers, so the two SQL sites cannot drift.
 *   - `freetextLogicalKey` — the JS form over the resolved Discogs master/release
 *     ids, consumed by the writer's free-text leg. It must emit key strings
 *     IDENTICAL to `logicalAlbumKeySql`'s `discogs:`-stripped output
 *     (`master:<id>` === substring('discogs:master:<id>' from 'discogs:(.*)')).
 *
 * `tests/unit/services/logical-album-key.service.test.ts` pins both forms — the
 * shared SQL builder and `freetextLogicalKey` — to the same expected keys for the
 * master / release / other-scheme / NULL inputs, and fails if they drift. (It
 * pins the SQL fragment's TEXT, not its Postgres evaluation; the pg integration
 * specs prove the SQL actually evaluates to those keys.)
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * The logical-album-key derivation as a Drizzle `sql` fragment, parameterized by
 * the `canonical_entity_id` and `id` column expressions so the two SQL sites
 * share one definition:
 *
 *   - reader (catalog-export) passes Drizzle column refs:
 *       `logicalAlbumKeySql(library.canonical_entity_id, library.id)`
 *   - writer (album-popularity rebuild) passes raw aliased SQL because the CASE
 *     sits inside a subquery that aliases `library` as `l`:
 *       `logicalAlbumKeySql(sql.raw('l."canonical_entity_id"'), sql.raw('l."id"'))`
 *
 * Branches:
 *   - `'discogs:master:<id>'` / `'discogs:release:<id>'` -> `'master:<id>'` /
 *     `'release:<id>'` — strip only the `discogs:` namespace; the master/release
 *     segment IS the key. This IS the collapse: every pressing sharing a master
 *     folds into one key (`discogs:master:<id>` for ~90% of resolved rows).
 *   - any other non-null scheme -> verbatim. Defensive: a non-`discogs:` scheme
 *     should not exist today, but use it as-is rather than letting `substring()`
 *     return NULL and violate the `album_popularity` NOT NULL primary key.
 *   - NULL `canonical_entity_id` -> `'library:<id>'` — an unresolved-but-played
 *     row keeps its own logical album so its plays are never lost.
 */
export const logicalAlbumKeySql = (canonicalEntityId: SQLWrapper, libraryId: SQLWrapper): SQL =>
  sql`CASE
        WHEN ${canonicalEntityId} LIKE 'discogs:%'
          THEN substring(${canonicalEntityId} from 'discogs:(.*)')
        WHEN ${canonicalEntityId} IS NOT NULL
          THEN ${canonicalEntityId}
        ELSE 'library:' || ${libraryId}::text
      END`;

/**
 * The logical_album_key for a free-text resolution row, or null when the row
 * resolved to neither a master nor a release (a no-match — unattributable, so
 * its plays contribute nothing). Master wins over release so every pressing
 * folds into the master key; this MUST stay identical to `logicalAlbumKeySql`'s
 * `discogs:`-stripped output (the parity is asserted in the unit test).
 */
export const freetextLogicalKey = (row: {
  discogs_master_id: number | null;
  discogs_release_id: number | null;
}): string | null => {
  if (row.discogs_master_id != null) return `master:${row.discogs_master_id}`;
  if (row.discogs_release_id != null) return `release:${row.discogs_release_id}`;
  return null;
};
