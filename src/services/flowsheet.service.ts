import { desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, flowsheet, shows, Show, NewShow, rotation } from '../db/schema';
import { IFSEntry } from '../controllers/flowsheet.controller';

export const getEntriesFromDB = async (offset: number, limit: number) => {
  const response: IFSEntry[] = await db
    .select({
      id: flowsheet.id,
      show_id: flowsheet.show_id,
      album_id: flowsheet.album_id,
      artist_name: flowsheet.artist_name,
      album_title: flowsheet.album_title,
      track_title: flowsheet.track_title,
      record_label: flowsheet.record_label,
      rotation_id: flowsheet.rotation_id,
      rotation_play_freq: rotation.play_freq,
      request_flag: flowsheet.request_flag,
      message: flowsheet.message,
      play_order: flowsheet.play_order,
    })
    .from(flowsheet)
    .innerJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
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

export const addDJToShow = async (
  req_dj_id: number,
  req_show_name?: string,
  req_specialty_id?: number
): Promise<Show> => {
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
