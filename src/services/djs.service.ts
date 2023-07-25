import { db } from '../db/drizzle_client';
import { NewDJ, DJ, djs } from '../db/schema';
import { sql } from 'drizzle-orm';

export const insertDJ = async (new_dj: NewDJ) => {
  const response = await db.insert(djs).values(new_dj).returning();
  return response[0];
};

export type DJQueryParams = {
  id: number;
  email: string;
  dj_name: string;
  real_name: string;
};

export const getDJInfo = async (items: DJQueryParams) /*:Promise<schema.DJ>*/ => {
  let query_value: number | string;
  let query_col;
  if (items.id) {
    query_value = items.id;
    query_col = djs.id;
  } else if (items.email) {
    query_value = items.email;
    query_col = djs.email;
  } else if (items.dj_name) {
    query_value = items.dj_name;
    query_col = djs.dj_name;
  } else if (items.real_name) {
    query_value = items.real_name;
    query_col = djs.real_name;
  } else {
    throw new Error('Did not specify a query parameter');
  }

  console.log(query_value);
  console.log('------------------------');
  console.log(typeof query_value);
  const dj_obj: DJ[] = await db
    .select()
    .from(djs)
    .where(sql`${query_col} = ${query_value}`);

  //console.log(dj_obj);
  return dj_obj;
};
