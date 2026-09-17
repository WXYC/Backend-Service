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
import { eq } from 'drizzle-orm';
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
 * One irreplaceable child table to capture. `name` becomes the JSON key
 * under `catalog_delete_snapshot.captured` — the child table's own DB name,
 * so a future restore replay can address it without a side lookup table.
 * `column` is the FK column on `table` that points back at the deleted
 * parent.
 */
export type CatalogDeleteChild = {
  name: string;
  table: PgTable;
  column: AnyPgColumn;
};

/**
 * Reads every row across `children` that references `entityId` and writes
 * ONE `catalog_delete_snapshot` row holding all of them as JSON, keyed by
 * `child.name`. Batch id defaults to a fresh UUID; a caller capturing
 * several entities under one delete (e.g. an artist and its releases)
 * passes the same `batchId` to each call so the rows group together.
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
    captured[child.name] = await tx.select().from(child.table).where(eq(child.column, params.entityId));
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
