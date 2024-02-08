import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { IFSEntry, UpdateRequestBody } from '../controllers/flowsheet.controller';
import { db } from '../db/drizzle_client';
import {
  DJ,
  FSEntry,
  NewFSEntry,
  Show,
  ShowDJ,
  artists,
  djs,
  flowsheet,
  library,
  // NewShow,
  rotation,
  show_djs,
  shows
} from '../db/schema';

export const getEntriesByPage = async (offset: number, limit: number) => {
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

export const getEntriesByRange = async (startId: number, endId: number) => {
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
    .where(and(gte(flowsheet.id, startId), lte(flowsheet.id, endId)))
    .orderBy(desc(flowsheet.play_order));

  return response;
};

export const addTrack = async (entry: NewFSEntry): Promise<FSEntry> => {
  const response = await db.insert(flowsheet).values(entry).returning();
  return response[0];
};

export const removeTrack = async (entry_id: number): Promise<FSEntry> => {
  const response = await db.delete(flowsheet).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};

export const updateEntry = async (entry_id: number, entry: UpdateRequestBody): Promise<FSEntry> => {
  const response = await db.update(flowsheet).set(entry).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};

export const startShow = async (dj_id: number, show_name?: string, specialty_id?: number): Promise<Show> => {

  const dj_info = (await db.select().from(djs).where(eq(djs.id, dj_id)).limit(1))[0];

  const new_show = await db
    .insert(shows)
    .values({
      primary_dj_id: dj_id,
      specialty_id: specialty_id,
      show_name: show_name,
    })
    .returning();

  await db
    .insert(show_djs)
    .values({
      show_id: new_show[0].id,
      dj_id: dj_id,
    })
    .returning();

  await db.insert(flowsheet).values({
    message: `Start of Show: DJ ${dj_info.dj_name} joined the set at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`
  });

  return new_show[0];
};

export const addDJToShow = async (dj_id: number, current_show: Show): Promise<ShowDJ> => {
  let show_dj_instance = await db
    .select()
    .from(show_djs)
    .where(and(eq(show_djs.show_id, current_show.id), eq(show_djs.dj_id, dj_id)))
    .limit(1);

  if (!show_dj_instance || show_dj_instance.length === 0) {
    const new_instance = await db
      .insert(show_djs)
      .values({
        show_id: current_show.id,
        dj_id: dj_id,
      })
      .returning();

    show_dj_instance = new_instance;

    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(dj_id);
    // --------------------------------
  } else if (show_dj_instance[0].active == false) {
    const new_instance = await db
      .update(show_djs)
      .set({ active: true })
      .where(and(eq(show_djs.show_id, current_show.id), eq(show_djs.dj_id, dj_id)))
      .returning();

    show_dj_instance = new_instance;

    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(dj_id);
    // --------------------------------
  }

  return show_dj_instance[0];
};

const createJoinNotification = async (id: number): Promise<FSEntry> => {
  let dj_name = 'A DJ';
  const dj: DJ = (await db.select().from(djs).where(eq(djs.id, id)))[0];

  dj_name = dj.dj_name ?? dj_name;

  const message = `${dj_name} joined the set!`;

  const notification = await db
    .insert(flowsheet)
    .values({
      artist_name: '',
      album_title: '',
      track_title: '',
      message: message,
    })
    .returning();

  return notification[0];
};

export const endShow = async (currentShow: Show): Promise<Show> => {
  //Add leave notification for all remaining guest djs;
  //Update their active state and set show end time.

  const primary_dj_id = currentShow.primary_dj_id;
  if (!primary_dj_id) throw new Error('Primary DJ not found');

  const remaining_djs = await db.select().from(show_djs).where(and(
    eq(show_djs.show_id, currentShow.id),
    eq(show_djs.active, true)
  ));

  await Promise.all(remaining_djs.map(async (dj) => {
    await db.update(show_djs).set({ active: false }).where(eq(show_djs.dj_id, dj.dj_id));
    if (dj.dj_id === primary_dj_id) return;
    await createLeaveNotification(dj.dj_id);
  }));

  const dj_information = (await db.select().from(djs).where(eq(djs.id, primary_dj_id)).limit(1))[0];

  await db.insert(flowsheet).values({
    message: `End of Show: DJ ${dj_information.dj_name} left the set at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`
  });

  await db.update(shows).set({ end_time: new Date() }).where(eq(shows.id, currentShow.id));


  return await getLatestShow();
};

export const leaveShow = async (dj_id: number, currentShow: Show): Promise<ShowDJ> => {
  const update_result = (
    await db
      .update(show_djs)
      .set({ active: false })
      .where(and(eq(show_djs.show_id, currentShow.id), eq(show_djs.dj_id, dj_id)))
      .returning()
  )[0];

  if (update_result === undefined) {
    throw new Error('DJ not in show');
  }

  // -- Add DJ Left to Flowsheet --
  await createLeaveNotification(dj_id);
  // -------------------------------

  return update_result;
};

const createLeaveNotification = async (id: number): Promise<FSEntry> => {
  let dj_name = 'A DJ';
  const dj: DJ = (await db.select().from(djs).where(eq(djs.id, id)))[0];

  dj_name = dj.dj_name ?? dj_name;

  const message = `${dj_name} left the set!`;

  const notification = await db
    .insert(flowsheet)
    .values({
      artist_name: '',
      album_title: '',
      track_title: '',
      message: message,
    })
    .returning();

  return notification[0];
};

export const getLatestShow = async (): Promise<Show> => {
  const latest_show = (await db.select().from(shows).orderBy(desc(shows.id)).limit(1))[0];
  return latest_show;
};

export const getOnAirStatusForDJ = async (dj_id: number): Promise<boolean> => {
  const latest_show = await getLatestShow();

  const showDj = await db
    .select()
    .from(show_djs)
    .where(and(eq(show_djs.show_id, latest_show.id), eq(show_djs.dj_id, dj_id)))
    .limit(1);

  return showDj[0]?.active ?? false;
};

export const getDJsInCurrentShow = async (): Promise<string> => {
  const latest_show = await getLatestShow();
  const dj_ids = (await db.select().from(show_djs).where(eq(show_djs.show_id, latest_show.id))).map((dj) => dj.dj_id);
  const dj_names = [];

  for (let i = 0; i < dj_ids.length; i++) {
    if (dj_ids[i] === -1) continue;
    const dj = (await db.select().from(djs).where(eq(djs.id, dj_ids[i])))[0];
    if (dj) {
      dj_names.push(dj);
    }
  }

  let djs_string = dj_names.map((dj) => dj.dj_name).join(', ');
  if (djs_string === '') {
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
