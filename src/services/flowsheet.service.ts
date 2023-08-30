import { sql, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, flowsheet, shows, Show, NewShow, rotation, library, artists, DJ, djs } from '../db/schema';
import { IFSEntry, UpdateRequestBody } from '../controllers/flowsheet.controller';

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

  return response;
};

export const addTrack = async (entry: NewFSEntry) => {
  const response = await db.insert(flowsheet).values(entry).returning();
  return response[0];
};

export const removeTrack = async (entry_id: number) => {
  const response = await db.delete(flowsheet).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};

export const patchTrack = async (entry_id: number, entry: UpdateRequestBody) => {
  const response = await db.update(flowsheet).set(entry).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};


export const addDJToShow = async (
  req_dj_id: number,
  req_show_name?: string,
  req_specialty_id?: number
): Promise<Show> => {
  const latestShow = await getLatestShow();

  const showExists = latestShow.end_time === null;
  const showDjs = [latestShow.dj_id, latestShow.dj_id2, latestShow.dj_id3];
  const djInShow = showDjs.includes(req_dj_id);
  const nextDjSlot = showDjs.indexOf(null);

  if (nextDjSlot === -1) {
    throw new Error('No available DJ slots');
  }

  const createJoinNotification = async (id: number) => {
    let dj_name: string = 'DJ';
    const dj: DJ = (await db.select().from(djs).where(eq(djs.id, id)))[0];
    if (dj) {
      dj_name = dj.dj_name ?? dj_name;
    } else {
      throw new Error('DJ not found');
    }

    const message = `${dj_name} joined the show!`;

    await db.insert(flowsheet).values({
      show_id: latestShow.id,
      artist_name: '',
      album_title: '',
      track_title: '',
      message: message,
    });
  }

  if (showExists) {
    if (djInShow) {
      return latestShow;
    } else {
      const show_session: Show = (
        await db
          .update(shows)
          .set({ [`dj_id${nextDjSlot + 1}`]: req_dj_id })
          .where(eq(shows.id, latestShow.id))
          .returning()
      )[0];
      // -- Add DJ Joined to Flowsheet --
      await createJoinNotification(req_dj_id);
      // --------------------------------
      return show_session;
    }
  } else {
    // Show must be created
    const show_data: NewShow = { dj_id: req_dj_id, specialty_id: req_specialty_id, show_name: req_show_name };
    const new_show: Show = (await db.insert(shows).values(show_data).returning())[0];
    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(req_dj_id);
    // --------------------------------
    return new_show;
  }
};

export const endShow = async (show_id: number) => {
  const currentShow = await getLatestShow();
  let err;
  if (currentShow.id !== +show_id || currentShow.end_time !== null) {
    err = 'Invalid show_id';
    return [err, currentShow];
  } else {
    const finalizedShow = await db
      .update(shows)
      .set({ end_time: sql`CURRENT_TIMESTAMP` })
      .where(eq(shows.id, show_id))
      .returning();
    return [err, finalizedShow[0]];
  }
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
