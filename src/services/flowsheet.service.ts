import { sql, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, flowsheet, shows, Show, NewShow, rotation, library, artists } from '../db/schema';
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
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .orderBy(desc(flowsheet.play_order))
    .offset(offset)
    .limit(limit);
  console.log(response);

  return response;
};

export const addTrack = async (entry: NewFSEntry) => {
  const response = await db.insert(flowsheet).values(entry).returning();
  return response[0];
};

export const addDJToShow = async (
  req_dj_id: number,
  req_show_name?: string,
  req_specialty_id?: number
): Promise<Show> => {
  const latestShow = await getLatestShow();

  if (latestShow.end_time === null) {
    let show_session: Show;
    if (latestShow.dj_id2 === null && latestShow.dj_id != req_dj_id) {
      show_session = (
        await db.update(shows).set({ dj_id2: req_dj_id }).where(eq(shows.id, latestShow.id)).returning()
      )[0];
      console.log(show_session);
    } else if (latestShow.dj_id3 === null && latestShow.dj_id2 != req_dj_id && latestShow.dj_id != req_dj_id) {
      show_session = (
        await db.update(shows).set({ dj_id3: req_dj_id }).where(eq(shows.id, latestShow.id)).returning()
      )[0];
    } else {
      return latestShow;
    }
    return show_session;
  } else {
    const new_show: NewShow = { dj_id: req_dj_id, specialty_id: req_specialty_id, show_name: req_show_name };
    const show_session: Show = (await db.insert(shows).values(new_show).returning())[0];
    return show_session;
  }
};

export const endShow = async (show_id: number) => {
  const current_show = await getLatestShow();

  if (current_show.id !== +show_id || current_show.end_time !== null) {
    throw new Error('Invalid show_id');
  }

  const finalizedShow = await db
    .update(shows)
    .set({ end_time: sql`CURRENT_TIMESTAMP` })
    .where(eq(shows.id, show_id))
    .returning();

  return finalizedShow[0];
};

export const getLatestShow = async (): Promise<Show> => {
  const latest_show = (await db.select().from(shows).orderBy(desc(shows.id)).limit(1))[0];
  return latest_show;
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      artist_name: artists.artist_name,
      album_title: library.album_title,
      record_label: library.label,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .where(eq(library.id, album_id))
    .limit(1);

  return album[0];
};
