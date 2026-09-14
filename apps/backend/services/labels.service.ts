import { eq, sql } from 'drizzle-orm';
import { db, labels, Label } from '@wxyc/database';
import { ilikeEscaped } from '../utils/sql-like.js';
// Type-only import (erased at runtime, so no service-cycle hazard): the
// transaction-handle type lives with `db.transaction`'s primary composer.
import type { DbTransaction } from './library.service.js';

export const getAllLabels = async (): Promise<Label[]> => {
  return await db.select().from(labels);
};

// `tx` (BS#2474): `POST /library/filings` resolves its label inside the one
// transaction the composite opens, so this read must ride that transaction's
// own connection rather than borrowing a second one from the pool — see
// `addToRotation`'s identity-read comment for the pool-wedge mechanics.
export const getLabelById = async (id: number, tx?: DbTransaction): Promise<Label | undefined> => {
  const result = await (tx ?? db).select().from(labels).where(eq(labels.id, id)).limit(1);
  return result[0];
};

// `tx` (BS#2474): the create-or-reuse INSERT below is a real write. Left on
// the bare pool it commits immediately, so a caller composing it into a
// larger all-or-nothing request (`POST /library/filings`) would strand a
// fresh `labels` row when a later stage rolls the transaction back — the
// exact near-duplicate-labels outcome `resolveNewAlbumLabel`'s `label_id`
// path exists to prevent. Passed, both the INSERT and its conflict-fallback
// SELECT run on the caller's transaction.
export const createLabel = async (labelName: string, parentLabelId?: number, tx?: DbTransaction): Promise<Label> => {
  const values: { label_name: string; parent_label_id?: number } = {
    label_name: labelName,
  };
  if (parentLabelId !== undefined) {
    values.parent_label_id = parentLabelId;
  }

  const executor = tx ?? db;
  const result = await executor
    .insert(labels)
    .values(values)
    .onConflictDoNothing({ target: labels.label_name })
    .returning();

  // If conflict (label already exists), fetch the existing one
  if (result.length === 0) {
    const existing = await executor.select().from(labels).where(eq(labels.label_name, labelName)).limit(1);
    return existing[0];
  }

  return result[0];
};

export const searchLabels = async (query: string, limit = 10): Promise<Label[]> => {
  const searchQuery = sql`
    SELECT * FROM ${labels}
    WHERE ${ilikeEscaped(labels.label_name, query, 'prefix')}
    ORDER BY ${labels.label_name}
    LIMIT ${limit}
  `;
  const response = await db.execute(searchQuery);
  return response as unknown as Label[];
};
