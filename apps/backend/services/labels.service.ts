import { eq, sql } from 'drizzle-orm';
import { db, labels, Label } from '@wxyc/database';

export const getAllLabels = async (): Promise<Label[]> => {
  return await db.select().from(labels);
};

export const getLabelById = async (id: number): Promise<Label | undefined> => {
  const result = await db
    .select()
    .from(labels)
    .where(eq(labels.id, id))
    .limit(1);
  return result[0];
};

export const createLabel = async (
  labelName: string,
  parentLabelId?: number
): Promise<Label> => {
  const values: { label_name: string; parent_label_id?: number } = {
    label_name: labelName,
  };
  if (parentLabelId !== undefined) {
    values.parent_label_id = parentLabelId;
  }

  const result = await db
    .insert(labels)
    .values(values)
    .onConflictDoNothing({ target: labels.label_name })
    .returning();

  // If conflict (label already exists), fetch the existing one
  if (result.length === 0) {
    const existing = await db
      .select()
      .from(labels)
      .where(eq(labels.label_name, labelName))
      .limit(1);
    return existing[0];
  }

  return result[0];
};

export const searchLabels = async (
  query: string,
  limit = 10
): Promise<Label[]> => {
  const searchQuery = sql`
    SELECT * FROM ${labels}
    WHERE ${labels.label_name} ILIKE ${query + '%'}
    ORDER BY ${labels.label_name}
    LIMIT ${limit}
  `;
  const response = await db.execute(searchQuery);
  return response.rows as Label[];
};
