import { sql, desc, eq, and } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewFSEntry, flowsheet, shows, Show, NewShow, rotation, library, artists, DJ, djs, FSEntry, show_djs, ShowDJ } from '../db/schema';
import { IFSEntry, UpdateRequestBody } from '../controllers/flowsheet.controller';

export const getEntriesFromDB = async (offset: number, limit: number) => {
  const response: IFSEntry[] = await db
    .select({
      id: flowsheet.id,
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
): Promise<ShowDJ> => {
  let latestShow = await getLatestShow();

  // a show is not considered finished until its end time is set
  const showExistsAndIsActive = latestShow && !(latestShow?.end_time ?? null);
  console.log(`show exists and is active: ${showExistsAndIsActive}`);
  if (!showExistsAndIsActive) {
    let new_show = await (
      db.insert(shows)
        .values({
          specialty_id: req_specialty_id,
          show_name: req_show_name,
        })
        .returning()
    );
    latestShow = new_show[0];
  }

  let show_dj_instance = await (
    db.select().from(show_djs)
    .where(and(
      eq(show_djs.show_id, latestShow.id),
      eq(show_djs.dj_id, req_dj_id)
    )).limit(1)
  );

  if (!show_dj_instance || show_dj_instance.length === 0) {
    let new_instance = await (
      db.insert(show_djs)
      .values({
        show_id: latestShow.id,
        dj_id: req_dj_id,
        active: false,
      }).returning()
    );

    show_dj_instance = new_instance;

    // -- Add DJ Joined to Flowsheet --
    let notif_start = await createJoinNotification(req_dj_id, latestShow.id);
    // --------------------------------

    let this_shows_djs = await db.select().from(show_djs).where(eq(show_djs.show_id, latestShow.id));
    if (this_shows_djs.length === 1) {
      await db.update(shows).set({ flowsheet_start_index: notif_start.id }).where(eq(shows.id, latestShow.id));
    }
  }

  let update_result = await (
    db.update(show_djs)
    .set({ active: true })
    .where(eq(show_djs.id, show_dj_instance[0].id))
    .returning()
  );

  return update_result[0];

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
      artist_name: '',
      album_title: '',
      track_title: '',
      message: message,
    }).returning();

  return notification[0];
};

export const leaveShow = async (dj_id: number): Promise<ShowDJ> => {
  const currentShow = await getLatestShow();

  const show_dj_instance = await (
    db.select().from(show_djs)
    .where(and(
      eq(show_djs.show_id, currentShow.id),
      eq(show_djs.dj_id, dj_id)
    )).limit(1)
  );

  if (!show_dj_instance) {
    throw new Error('DJ not in show');
  }

  let update_result = await (
    db.update(show_djs)
    .set({ active: false })
    .where(eq(show_djs.id, show_dj_instance[0].id))
    .returning()
  );

  // -- Add DJ Left to Flowsheet --
  let notif_end = await createLeaveNotification(dj_id);
  // -------------------------------

  let this_shows_djs = await db.select().from(show_djs).where(eq(show_djs.show_id, currentShow.id));
  let everyone_left = false;
  if (this_shows_djs.length === 0) {
    everyone_left = true;
  } else {
    everyone_left = this_shows_djs.every((dj) => !dj.active);
  }
  if (everyone_left) {
      await db.update(shows).set({ flowsheet_end_index: notif_end.id, end_time: sql`NOW()` }).where(eq(shows.id, currentShow.id));
  }

  return update_result[0];
};

const createLeaveNotification = async (id: number) => {
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

export const getOnAirStatusForDJ = async (dj_id: number): Promise<boolean> => {
  const latest_show = await getLatestShow();
  
  const showDj = await (
    db.select().from(show_djs)
    .where(and(
      eq(show_djs.show_id, latest_show.id),
      eq(show_djs.dj_id, dj_id),
    )).limit(1)
  );

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
