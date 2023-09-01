import { sql, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, flowsheet, shows, Show, NewShow, rotation, library, artists, DJ, djs, FSEntry } from '../db/schema';
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
  const showExistsAndIsActive = latestShow && !(latestShow?.end_time ?? null);
  const showDjs = [latestShow?.dj_id ?? null, latestShow?.dj_id2 ?? null, latestShow?.dj_id3 ?? null];
  const djInShow = showDjs.includes(req_dj_id);
  const nextDjSlot = showDjs.indexOf(null);

  if (nextDjSlot === -1) {
    throw new Error('No available DJ slots');
  }

  if (showExistsAndIsActive) {
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
      await createJoinNotification(req_dj_id, show_session.id);
      // --------------------------------
      return show_session;
    }
  } else {
    // Show must be created
    const show_data: NewShow = { dj_id: req_dj_id, specialty_id: req_specialty_id, show_name: req_show_name };
    const new_show: Show = (await db.insert(shows).values(show_data).returning())[0];
    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(req_dj_id, new_show.id);
    // --------------------------------
    return new_show;
  }
};

const createJoinNotification = async (id: number, show_id: number) => {
  let dj_name: string = 'DJ';
  const dj: DJ = (await db.select().from(djs).where(eq(djs.id, id)))[0];
  if (dj) {
    dj_name = dj.dj_name ?? dj_name;
  } else {
    throw new Error('DJ not found');
  }

  const message = `DJ ${dj_name} joined the set!`;

  const notification = await db.insert(flowsheet)
    .values({
      show_id: show_id,
      artist_name: '',
      album_title: '',
      track_title: '',
      message: message,
    }).returning();

  return notification[0];
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
    // -- Add DJ Left to Flowsheet --
    await createLeaveNotification(currentShow.dj_id, currentShow.id);
    // -------------------------------
    return [err, finalizedShow[0]];
  }
};

const createLeaveNotification = async (id: number, show_id: number) => {
  let dj_name: string = 'DJ';
  const dj: DJ = (await db.select().from(djs).where(eq(djs.id, id)))[0];
  if (dj) {
    dj_name = dj.dj_name ?? dj_name;
  } else {
    throw new Error('DJ not found');
  }

  const message = `DJ ${dj_name} left the set!`;

  const notification = await db.insert(flowsheet)
    .values({
      show_id: show_id,
      artist_name: '',
      album_title: '',
      track_title: '',
      message: message,
    }).returning();

  return notification[0];
};

export const getLatestShow = async (): Promise<Show> => {
  const latest_show = (await db.select().from(shows).orderBy(desc(shows.id)).limit(1))[0];
  return latest_show;
};

export const getDJsInCurrentShow = async (): Promise<string> => {
  const latest_show = await getLatestShow();
  const dj_ids = [latest_show.dj_id ?? -1, latest_show.dj_id2 ?? -1, latest_show.dj_id3 ?? -1];
  const dj_names = [];

  for (let i = 0; i < dj_ids.length; i++) {
    if (dj_ids[i] === -1) continue;
    const dj = (await db.select().from(djs).where(eq(djs.id, dj_ids[i])))[0];
    if (dj) {
      dj_names.push(dj);
    }
  }

  let djs_string = dj_names.map((dj) => dj.dj_name).join(', ');
  if (djs_string === '' ) {
    djs_string = 'Off Air';
  } else {
    const last_comma = djs_string.lastIndexOf(',');
    djs_string = djs_string.substring(0, last_comma) + ' and' + djs_string.substring(last_comma + 1);
  }
  return djs_string;
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
