/**
 * Reusable before-state capture for a catalog delete (BS#2560 / F1). Lives
 * here, not in `apps/backend/services/library.service.ts`, because
 * WXYC/Backend-Service#2562 wires an artist delete onto this SAME function —
 * the helper must not assume the deleted subject is an album, so it takes
 * an open `entityKind`/`entityId` pair and a caller-supplied child list
 * rather than any album-shaped defaults.
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
import { eq, inArray } from 'drizzle-orm';
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
 * A depth-1 child: `column` is the FK column on `table` that points
 * directly at the deleted parent (compared against `entityId`).
 *
 * A depth-2 (grandchild) child: `column` is instead an FK that points at
 * ANOTHER table's row id — a table that is itself a depth-1 child of the
 * deleted parent. `via` names that lookup: `via.table`/`via.column` are the
 * parent child's own `{table, column}` pair (compared against `entityId`,
 * same as a depth-1 capture), and `via.idColumn` is the parent's own id
 * column, the one `column` actually references. Concrete example: capturing
 * `rotation_urls` when deleting a `library` row —
 * `rotation_urls.rotation_id` points at `rotation.id`, not at `library.id`,
 * and `rotation.album_id` -> `library.id` is the depth-1 hop that gets you
 * there. `via` is resolved as ONE correlated subquery (`WHERE column IN
 * (SELECT idColumn FROM via.table WHERE via.column = entityId)`), not a
 * separate round trip.
 *
 * Only two levels deep on purpose: nothing in the schema today needs a
 * third hop, and a generic N-deep chain is speculative complexity this
 * helper does not need yet.
 */
export type CatalogDeleteChild = {
  /** Becomes the JSON key under `catalog_delete_snapshot.captured` — the child table's own DB name. */
  name: string;
  table: PgTable;
  column: AnyPgColumn;
  via?: {
    table: PgTable;
    column: AnyPgColumn;
    idColumn: AnyPgColumn;
  };
};

/**
 * Type-checked constructor for a depth-1 {@link CatalogDeleteChild}. Plain
 * object literals compile even when `column` belongs to a DIFFERENT table
 * than `table` — Drizzle types `PgTable` and `AnyPgColumn` independently, so
 * nothing stops `{ table: bins, column: reviews.album_id }` from
 * type-checking and then either throwing a missing-FROM-clause error at
 * runtime or, worse, silently capturing the wrong rows if the mismatched
 * column happens to belong to a table already in scope. The generic here
 * binds `column` to `table`'s own name so a mismatch fails to COMPILE
 * instead. Prefer this over a bare object literal for every new child;
 * WXYC/Backend-Service#2562 is the next caller and inherits whichever habit
 * this helper sets.
 */
export function catalogDeleteChild<T extends PgTable>(
  name: string,
  table: T,
  column: AnyPgColumn<{ tableName: T['_']['name'] }>
): CatalogDeleteChild {
  return { name, table, column };
}

/**
 * Type-checked constructor for a depth-2 {@link CatalogDeleteChild} — see
 * the type's own docstring for the `via` shape. `parent` is the SAME
 * `{table, column}` pair already passed to the parent's own
 * {@link catalogDeleteChild} call (or would be, if the parent is itself
 * captured); `parentIdColumn` is that parent table's own id/PK column.
 */
export function catalogDeleteGrandchild<TParent extends PgTable, TChild extends PgTable>(
  name: string,
  table: TChild,
  column: AnyPgColumn<{ tableName: TChild['_']['name'] }>,
  parent: {
    table: TParent;
    column: AnyPgColumn<{ tableName: TParent['_']['name'] }>;
    idColumn: AnyPgColumn<{ tableName: TParent['_']['name'] }>;
  }
): CatalogDeleteChild {
  return { name, table, column, via: parent };
}

/**
 * Reads every row across `children` that references `entityId` (directly,
 * or transitively through a `via` depth-2 hop — see {@link CatalogDeleteChild})
 * and writes ONE `catalog_delete_snapshot` row holding all of them as JSON,
 * keyed by `child.name`. Batch id defaults to a fresh UUID; a caller
 * capturing several entities under one delete (e.g. an artist and its
 * releases) passes the same `batchId` to each call so the rows group
 * together.
 *
 * **Known tradeoff, recorded rather than silently accepted (BS#2560
 * review):** each child is one `await`ed round trip, run serially, inside a
 * transaction that already holds `FOR UPDATE` on the parent row — so a
 * caller with N children pays N round trips (plus one insert) inside that
 * lock's window. Collapsing this into a single `json_build_object(...)` over
 * correlated subqueries would cut it to one round trip, but that is a
 * different query shape for every call site's `children` list, not a
 * bounded change to this function — left as follow-up work rather than
 * folded into BS#2560. Two of the release-delete's children read without an
 * index on their FK column (`bins`, which was already unindexed before this
 * helper existed, and `artist_library_crossreference`, whose only index
 * leads with `artist_id`); adding `bins(album_id)` is a plausible follow-up
 * migration but is a schema change orthogonal to this helper's contract.
 */
export async function captureCatalogDeleteSnapshot(
  tx: DbTransaction,
  params: {
    entityKind: string;
    entityId: number;
    children: CatalogDeleteChild[];
    batchId?: string;
    actor?: CatalogDeleteActor;
  }
): Promise<void> {
  const captured: Record<string, unknown[]> = {};
  for (const child of params.children) {
    if (child.via) {
      // A subquery, not a second awaited round trip: `tx.select(...)` here
      // is passed straight into `inArray` unresolved, so Postgres runs one
      // statement with a correlated `IN (SELECT ...)`, not two round trips.
      const parentIds = tx
        .select({ id: child.via.idColumn })
        .from(child.via.table)
        .where(eq(child.via.column, params.entityId));
      captured[child.name] = await tx.select().from(child.table).where(inArray(child.column, parentIds));
    } else {
      captured[child.name] = await tx.select().from(child.table).where(eq(child.column, params.entityId));
    }
  }
  await tx.insert(catalog_delete_snapshot).values({
    batch_id: params.batchId ?? randomUUID(),
    entity_kind: params.entityKind,
    entity_id: params.entityId,
    captured,
    actor_user_id: params.actor?.userId ?? null,
    actor_email: params.actor?.email ?? null,
    actor_role: params.actor?.role ?? null,
  });
}
