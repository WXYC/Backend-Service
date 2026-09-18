/**
 * Reusable before-state capture for a catalog delete (BS#2560 / F1). Lives
 * here, not in `apps/backend/services/library.service.ts`, because
 * WXYC/Backend-Service#2562 wires an artist delete onto this SAME function —
 * the helper must not assume the deleted subject is an album, so it takes
 * an open `entityKind`, the parent's own id column, and a caller-supplied
 * child list rather than any album-shaped defaults.
 *
 * Must be called from inside the same transaction as the delete it
 * protects, before that transaction's own DELETE statements run. There is
 * deliberately no try/catch here: a thrown read or a thrown insert
 * propagates out through the caller's `db.transaction(...)` callback and
 * rolls the whole delete back with it. See the `catalog_delete_snapshot`
 * docstring in `schema.ts` for why the legacy tubafrenzy mechanism (a
 * listener, wrapped in a catch that logged and swallowed) is exactly what
 * this corrects.
 */
import { randomUUID } from 'crypto';
import { eq, getTableColumns, getTableName, inArray } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from './client.js';
import { catalog_delete_snapshot } from './schema.js';

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CatalogDeleteActor = {
  userId?: string | null;
  email?: string | null;
  role?: string | null;
};

/**
 * A depth-1 child is just the FK column that points at the deleted parent:
 * pass `bins.album_id`, not a `{table, column, name}` triple. The table the
 * rows come from and the JSON key they land under are DERIVED from that one
 * column (`column.table`, then `getTableName(...)`), which is what makes a
 * table/column mismatch unrepresentable rather than merely documented — an
 * earlier revision of this helper passed all three and needed two generic
 * constructor functions to police the redundancy.
 *
 * A depth-2 (grandchild) child is `{ column, via }`: `column` is an FK that
 * points at ANOTHER table's row id — a table that is itself a depth-1 child
 * of the deleted parent. `via.column` is that intermediate table's own FK to
 * the deleted parent (compared against `entityId`, same as a depth-1
 * capture) and `via.idColumn` is the intermediate table's id column, the one
 * `column` actually references; both must live on that same intermediate
 * table, and the id lookup's FROM is derived from `via.idColumn`. Concrete
 * example: capturing `rotation_urls` when deleting a `library` row —
 * `rotation_urls.rotation_id` points at `rotation.id`, not at `library.id`,
 * and `rotation.album_id` -> `library.id` is the depth-1 hop that gets you
 * there. `via` is resolved as ONE correlated subquery (`WHERE column IN
 * (SELECT idColumn FROM via.idColumn's table WHERE via.column = entityId)`),
 * not a separate round trip. A `via.column` on some other table cannot
 * silently capture the wrong rows — that subquery has exactly one table in
 * its FROM, so a mismatch is a missing-FROM-clause error that rolls the
 * delete back.
 *
 * Only two levels deep on purpose: nothing in the schema today needs a
 * third hop, and a generic N-deep chain is speculative complexity this
 * helper does not need yet.
 */
export type CatalogDeleteChild =
  | AnyPgColumn
  | {
      column: AnyPgColumn;
      via: { column: AnyPgColumn; idColumn: AnyPgColumn };
    };

type ResolvedChild = {
  /** The JSON key under `captured.children` — the child table's own DB name. */
  key: string;
  table: PgTable;
  column: AnyPgColumn;
  via?: { column: AnyPgColumn; idColumn: AnyPgColumn };
};

/**
 * `Column.table` is reference-identical to the table object the column was
 * declared on, and `getTableName` on it returns the table's DB name — so a
 * bare column carries everything a capture needs. The `as PgTable` is the
 * one cast: drizzle types the back-reference as the base `Table`.
 */
const resolveChild = (child: CatalogDeleteChild): ResolvedChild => {
  const column = 'column' in child ? child.column : child;
  const table = column.table as PgTable;
  return { key: getTableName(table), table, column, via: 'column' in child ? child.via : undefined };
};

/**
 * Reads the deleted parent row plus every row across `children` that
 * references `entityId` (directly, or transitively through a `via` depth-2
 * hop — see {@link CatalogDeleteChild}) and writes ONE
 * `catalog_delete_snapshot` row holding all of them as JSON. Batch id
 * defaults to a fresh UUID; a caller capturing several entities under one
 * delete (e.g. an artist and its releases) passes the same `batchId` to each
 * call so the rows group together.
 *
 * **Stored shape.** `captured` is
 * `{ entity: { table, row }, children: { <childTableName>: rows[] } }`.
 * The two-key envelope is deliberate: the parent row and the child rows live
 * in separate namespaces, so no child table name can ever collide with the
 * parent's key, and `entity.table` names which table `entity.row` came from
 * (`entity_kind` is the queryable label — `'artist'` — not necessarily the
 * table name — `artists`). `entity.row` is every non-generated column of the
 * parent: generated columns (`library.search_doc`) are recomputed by
 * Postgres on re-insert, so storing one would be permanent waste.
 *
 * **The parent read is the only lock-free read here that is still atomic**,
 * because callers hold the parent row `FOR UPDATE` before calling (the
 * play-count guard's lock, in `deleteAlbumFromDB`'s case). Every child read
 * takes `FOR SHARE` for its own account: the enclosing transaction runs at
 * READ COMMITTED, and Postgres takes NO lock on a referenced parent row for
 * an UPDATE that leaves the FK column alone — so without this, a librarian's
 * concurrent edit to a captured child could commit between the capture and
 * the cascade and be destroyed with only its pre-edit version snapshotted.
 * `FOR SHARE` (not `FOR UPDATE`) is the weakest mode that conflicts with a
 * concurrent UPDATE/DELETE of those rows while still letting other readers
 * through. INSERTs of NEW child rows need no lock here — they take
 * `FOR KEY SHARE` on the parent row this transaction already holds
 * `FOR UPDATE` — except through a depth-2 hop, where the conflicting lock is
 * the one on the intermediate row (see `deleteAlbumFromDB`'s note on the
 * `rotation` lock). Callers must keep `lock_timeout` below
 * `deadlock_timeout` so a lock-order inversion against a live writer costs
 * this transaction a retryable failure rather than the writer an abort.
 *
 * **Known tradeoff, recorded rather than silently accepted (BS#2560
 * review):** each child is one `await`ed round trip, run serially, inside a
 * transaction that already holds `FOR UPDATE` on the parent row — so a
 * caller with N children pays N round trips (plus the parent read and one
 * insert) inside that lock's window. Collapsing this into a single
 * `json_build_object(...)` over correlated subqueries would cut it to one
 * round trip, but that is a different query shape for every call site's
 * `children` list, not a bounded change to this function — left as follow-up
 * work rather than folded into BS#2560. Two of the release-delete's children
 * read without an index on their FK column (`bins`, which was already
 * unindexed before this helper existed, and `artist_library_crossreference`,
 * whose only index leads with `artist_id`); adding `bins(album_id)` is a
 * plausible follow-up migration but is a schema change orthogonal to this
 * helper's contract.
 */
export async function captureCatalogDeleteSnapshot(
  tx: DbTransaction,
  params: {
    entityKind: string;
    entityId: number;
    /** The deleted parent's own id column — `library.id`, `artists.id`. Locates its table and its row. */
    entityIdColumn: AnyPgColumn;
    children: CatalogDeleteChild[];
    batchId?: string;
    actor?: CatalogDeleteActor;
  }
): Promise<void> {
  const entityTable = params.entityIdColumn.table as PgTable;
  const entityColumns = Object.fromEntries(
    Object.entries(getTableColumns(entityTable)).filter(([, column]) => !column.generated)
  ) as Record<string, AnyPgColumn>;
  const entityRows = await tx
    .select(entityColumns)
    .from(entityTable)
    .where(eq(params.entityIdColumn, params.entityId))
    .limit(1);

  const children: Record<string, unknown[]> = {};
  for (const child of params.children) {
    const { key, table, column, via } = resolveChild(child);
    if (via) {
      // A subquery, not a second awaited round trip: `tx.select(...)` here
      // is passed straight into `inArray` unresolved, so Postgres runs one
      // statement with a correlated `IN (SELECT ...)`, not two round trips.
      const parentIds = tx
        .select({ id: via.idColumn })
        .from(via.idColumn.table as PgTable)
        .where(eq(via.column, params.entityId));
      children[key] = await tx.select().from(table).where(inArray(column, parentIds)).for('share');
    } else {
      children[key] = await tx.select().from(table).where(eq(column, params.entityId)).for('share');
    }
  }

  await tx.insert(catalog_delete_snapshot).values({
    batch_id: params.batchId ?? randomUUID(),
    entity_kind: params.entityKind,
    entity_id: params.entityId,
    captured: { entity: { table: getTableName(entityTable), row: entityRows[0] ?? null }, children },
    actor_user_id: params.actor?.userId ?? null,
    actor_email: params.actor?.email ?? null,
    actor_role: params.actor?.role ?? null,
  });
}
