import { db } from './db/drizzle_client';
import * as schema from './db/schema';

export const insertNewDJ = async (new_dj: schema.NewDJ) => {
  const response = await db.insert(schema.djs).values(new_dj).returning();
  return response[0];
};
