import { count, eq, sql } from 'drizzle-orm';
import { db, extractSqlState, labels, Label } from '@wxyc/database';
import WxycError from '../utils/error.js';
import { ilikeEscaped } from '../utils/sql-like.js';
import { LABEL_REFERENCES, type LabelReferenceCounts } from './label-references.service.js';
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

export type LabelWithReferences = Label & { references: LabelReferenceCounts; child_labels: number };

type LabelEdits = { label_name?: string; parent_label_id?: number | null };

const UNIQUE_VIOLATION = '23505';

/** How many rows reference the label, per source, and how many labels name it as their parent. */
const countReferences = async (executor: DbTransaction | typeof db, id: number) => {
  const references = {} as LabelReferenceCounts;
  for (const { source, table, fkColumn } of LABEL_REFERENCES) {
    const [row] = await executor.select({ n: count() }).from(table).where(eq(fkColumn, id));
    references[source] = row.n;
  }
  const [children] = await executor.select({ n: count() }).from(labels).where(eq(labels.parent_label_id, id));
  return { references, child_labels: children.n };
};

export const getLabelWithReferences = async (id: number): Promise<LabelWithReferences | undefined> => {
  const label = await getLabelById(id);
  return label && { ...label, ...(await countReferences(db, id)) };
};

/** Refuses `parentId` when it is `id` itself or any of its descendants, by walking up from `parentId`. */
const assertParentAllowed = async (tx: DbTransaction, id: number, parentId: number) => {
  const seen = new Set<number>();
  for (let current: number | null = parentId; current !== null && !seen.has(current);) {
    if (current === id)
      throw new WxycError('A label cannot be its own parent or ancestor', 400, { code: 'label_parent_cycle' });
    seen.add(current);
    const label = await getLabelById(current, tx);
    if (!label) throw new WxycError('parent_label_id names no label', 400, { code: 'unknown_reference' });
    current = label.parent_label_id;
  }
};

/** Rewrites the name copy on every row pointing at the label, skipping rows whose copy is NULL. */
const rewriteNameCopies = async (tx: DbTransaction, id: number, name: string) => {
  const rewritten = {} as LabelReferenceCounts;
  for (const { source, table, fkColumn, textColumn } of LABEL_REFERENCES) {
    const result = await tx.execute(
      sql`UPDATE ${table} SET ${sql.identifier(textColumn.name)} = ${name} WHERE ${fkColumn} = ${id} AND ${textColumn} IS NOT NULL`
    );
    rewritten[source] = result.count;
  }
  return rewritten;
};

/**
 * Renames and/or re-parents a label. A rename rewrites the text copies of the name in the same transaction (BS#3289);
 * a name that belongs to another label is a 409 pointing at merge. Returns undefined when the label does not exist.
 */
export const updateLabel = async (id: number, edits: LabelEdits) => {
  try {
    return await db.transaction(async (tx) => {
      const current = await getLabelById(id, tx);
      if (!current) return undefined;
      if (edits.parent_label_id != null) await assertParentAllowed(tx, id, edits.parent_label_id);

      const [label] = await tx.update(labels).set(edits).where(eq(labels.id, id)).returning();
      const renamed = edits.label_name !== undefined && edits.label_name !== current.label_name;
      const rewritten = renamed
        ? await rewriteNameCopies(tx, id, edits.label_name!)
        : { library: 0, rotation: 0, flowsheet: 0, intake_items: 0 };
      return { label, rewritten };
    });
  } catch (error) {
    if (extractSqlState(error) === UNIQUE_VIOLATION) {
      throw new WxycError('Another label already has that name; merge the two labels instead', 409, {
        code: 'label_name_taken',
      });
    }
    throw error;
  }
};

/**
 * Deletes a label only when nothing references it: no foreign key in `LABEL_REFERENCES` and no child label. Refusal is
 * a 409 carrying the counts. Returns false when the label does not exist.
 */
export const deleteLabel = async (id: number): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    if (!(await getLabelById(id, tx))) return false;
    const { references, child_labels } = await countReferences(tx, id);
    if (child_labels > 0 || Object.values(references).some((n) => n > 0)) {
      throw new WxycError('Label is still referenced', 409, {
        code: 'label_in_use',
        details: { references, child_labels },
      });
    }
    await tx.delete(labels).where(eq(labels.id, id));
    return true;
  });
};
