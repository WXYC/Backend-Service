import { desc } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, FSEntry, flowsheet } from '../db/schema';

export const getTracks = async (offset: number, limit: number) => {
  const response: FSEntry[] = await db
    .select()
    .from(flowsheet)
    .orderBy(desc(flowsheet.show_id), desc(flowsheet.play_order))
    .offset(offset)
    .limit(limit);
  console.log(response);

  return response;
};

export const addTrack = async (entry: NewFSEntry) => {
  const response = await db.insert(flowsheet).values(entry);
  console.log(response);
  return response;
};
