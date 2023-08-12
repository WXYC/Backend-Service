import { db } from '../db/drizzle_client';
import { NewDJ, DJ, djs, bins, NewBinEntry, BinEntry } from '../db/schema';
import { sql, eq, and } from 'drizzle-orm';
import { DJQueryParams } from '../controllers/djs.controller';

export const insertDJ = async (new_dj: NewDJ) => {
  const response = await db.insert(djs).values(new_dj).returning();
  return response[0];
};

export const getDJInfoFromDB = async (items: DJQueryParams) /*:Promise<schema.DJ>*/ => {
  let query_value: number | string;
  let query_col;
  if (items.id !== undefined) {
    query_value = items.id;
    query_col = djs.id;
  } else if (items.cognito_user_name !== undefined) {
    query_value = items.cognito_user_name;
    query_col = djs.cognito_user_name;
  } else if (items.real_name !== undefined) {
    query_value = items.real_name;
    query_col = djs.real_name;
  } else {
    throw new Error('Did not specify a query parameter');
  }

  const dj_obj: DJ[] = await db
    .select()
    .from(djs)
    .where(sql`${query_col} = ${query_value}`);

  return dj_obj[0];
};

export const addToBin = async (bin_entry: NewBinEntry): Promise<BinEntry> => {
  const added_bin_entry = await db.insert(bins).values(bin_entry).returning();
  return added_bin_entry[0];
};

export const removeFromBin = async (bin_entry_id: number, dj_id: number): Promise<BinEntry> => {
  const removed_bin_entry = await db
    .delete(bins)
    .where(and(eq(bins.dj_id, dj_id), eq(bins.id, bin_entry_id)))
    .returning();
  return removed_bin_entry[0];
};
