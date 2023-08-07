import { desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, FSEntry, flowsheet, shows, Show, NewShow } from '../db/schema';

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
  const response = await db.insert(flowsheet).values(entry).returning();
  console.log(response);
  return response;
};

export const join_show = async (req_dj_id: number, req_show_name?: string, req_specialty_id?: number): Show => {
  const current_show = (await db.select().from(shows).orderBy(desc(shows.id)).limit(1))[0];
  console.log(current_show);

  if (current_show.end_time === null) {
    let show_session: Show;
    if (current_show.dj_id2 !== null) {
      show_session = (
        await db.update(shows).set({ dj_id2: req_dj_id }).where(eq(shows.id, current_show.id)).returning()
      )[0];
    } else if (current_show.dj_id3 !== null) {
      show_session = (
        await db.update(shows).set({ dj_id3: req_dj_id }).where(eq(shows.id, current_show.id)).returning()
      )[0];
    } else {
      return current_show;
    }
    return show_session;
  } else {
    const new_show: NewShow = { dj_id: req_dj_id, specialty_id: req_specialty_id, show_name: req_show_name };
    const show_session: Show = (await db.insert(shows).values(new_show).returning())[0];
    return show_session;
  }
};
