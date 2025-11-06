import { sql, desc, eq, and, lte, gte, inArray } from 'drizzle-orm';
import { db } from '../../../shared/database/src/client.js';
import {
  DJ,
  FSEntry,
  NewFSEntry,
  Show,
  ShowDJ,
  shows,
  artists,
  djs,
  flowsheet,
  library,
  rotation,
  show_djs,
  library_artist_view,
  specialty_shows,
} from "@wxyc/database";
import { IFSEntry, ShowInfo, UpdateRequestBody } from '../controllers/flowsheet.controller.js';
import { PgSelectQueryBuilder, QueryBuilder } from 'drizzle-orm/pg-core';

const FSEntryFields = {
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
  add_time: flowsheet.add_time,
};

export const getEntriesByPage = async (offset: number, limit: number) => {
  const response: IFSEntry[] = await db
    .select(FSEntryFields)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .orderBy(desc(flowsheet.play_order))
    .offset(offset)
    .limit(limit);

  return response;
};

export const getEntriesByRange = async (startId: number, endId: number) => {
  const response: IFSEntry[] = await db
    .select(FSEntryFields)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .where(and(gte(flowsheet.id, startId), lte(flowsheet.id, endId)))
    .orderBy(desc(flowsheet.play_order));

  return response;
};

export const getEntriesByShow = async (...show_ids: number[]) => {
  if (show_ids.length === 0) return [];

  // Get all entries from these shows
  const response: IFSEntry[] = await db
    .select(FSEntryFields)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .where(inArray(flowsheet.show_id, show_ids))
    .orderBy(desc(flowsheet.play_order));

  return response;
};

export const addTrack = async (entry: NewFSEntry): Promise<FSEntry> => {
  /*
    TODO: logic for updating album playcount 
  */
  // if (entry.artist_name || entry.album_title || entry.record_label) {
  //   const qb = new QueryBuilder();
  //   let query = qb.select().from(library_artist_view).$dynamic();
  //   query = withAlbumTitle(withArtistName(query, entry.artist_name), entry.album_title);
  //   console.log(query.toSQL());
  //   // query = withAlbumTitle(query, entry.album_title);
  //   // console.log(query.toSQL());
  //   query = withLabel(query, entry.record_label);
  //   console.log(query.toSQL());

  //   const matching_albums: LibraryArtistViewEntry[] = await db.execute(query);

  //   if (matching_albums.length > 0) {
  //     const matching_album_ids = matching_albums.map((album: LibraryArtistViewEntry) => {
  //       return album.id;
  //     });

  //     await db
  //       .update(library)
  //       .set({ last_modified: sql`current_timestamp()`, plays: sql`${library.plays} + 1` })
  //       .where(inArray(library.id, matching_album_ids));
  //   }
  // }

  const response = await db.insert(flowsheet).values(entry).returning();
  return response[0];
};

export const removeTrack = async (entry_id: number): Promise<FSEntry> => {
  /*
    TODO: logic for updating album playcount 
   */
  // const entry = await db.select().from(flowsheet).where(eq(flowsheet.id, entry_id)).limit(1);

  // if (entry.length === 0) {
  //   throw new Error('Entry not found');
  // }

  // const qb = new QueryBuilder();
  // const query = withArtistName(
  //   withAlbumTitle(
  //     withLabel(qb.select().from(library_artist_view).$dynamic(), entry[0].record_label),
  //     entry[0].album_title
  //   ),
  //   entry[0].artist_name
  // );

  // const matching_albums: LibraryArtistViewEntry[] = await db.execute(query);

  // if (matching_albums.length > 0) {
  //   const matching_album_ids = matching_albums.map((album: LibraryArtistViewEntry) => {
  //     return album.id;
  //   });

  //   await db
  //     .update(library)
  //     .set({ last_modified: sql`current_timestamp()`, plays: sql`${library.plays} - 1` })
  //     .where(inArray(library.id, matching_album_ids));
  // }

  const response = await db.delete(flowsheet).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};

function withArtistName<T extends PgSelectQueryBuilder>(qb: T, artist_name: string | null | undefined) {
  if (artist_name) {
    return qb.where(eq(library_artist_view.artist_name, artist_name));
  }
  return qb;
}

function withAlbumTitle<T extends PgSelectQueryBuilder>(qb: T, album_title: string | null | undefined) {
  if (album_title) {
    return qb.where(eq(library_artist_view.album_title, album_title));
  }
  return qb;
}

function withLabel<T extends PgSelectQueryBuilder>(qb: T, label: string | null | undefined) {
  if (label) {
    return qb.where(eq(library_artist_view.label, label));
  }
  return qb;
}

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
    show_id: new_show[0].id,
    message: `Start of Show: DJ ${dj_info.dj_name} joined the set at ${new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
    })}`,
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
    await createJoinNotification(dj_id, current_show.id);
    // --------------------------------
  } else if (show_dj_instance[0].active == false) {
    const new_instance = await db
      .update(show_djs)
      .set({ active: true })
      .where(and(eq(show_djs.show_id, current_show.id), eq(show_djs.dj_id, dj_id)))
      .returning();

    show_dj_instance = new_instance;

    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(dj_id, current_show.id);
    // --------------------------------
  }

  return show_dj_instance[0];
};

const createJoinNotification = async (id: number, show_id: number): Promise<FSEntry> => {
  let dj_name = 'A DJ';
  const dj: DJ = (await db.select().from(djs).where(eq(djs.id, id)))[0];

  dj_name = dj.dj_name ?? dj_name;

  const message = `${dj_name} joined the set!`;

  const notification = await db
    .insert(flowsheet)
    .values({
      show_id: show_id,
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

  const remaining_djs = await db
    .select()
    .from(show_djs)
    .where(and(eq(show_djs.show_id, currentShow.id), eq(show_djs.active, true)));

  await Promise.all(
    remaining_djs.map(async (dj) => {
      await db.update(show_djs).set({ active: false }).where(eq(show_djs.dj_id, dj.dj_id));
      if (dj.dj_id === primary_dj_id) return;
      await createLeaveNotification(dj.dj_id, currentShow.id);
    })
  );

  const dj_information = (await db.select().from(djs).where(eq(djs.id, primary_dj_id)).limit(1))[0];
  const dj_name = dj_information.dj_name ? dj_information.dj_name : 'A DJ';

  await db.insert(flowsheet).values({
    show_id: currentShow.id,
    message: `End of Show: ${dj_name} left the set at ${new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
    })}`,
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

  // In case gaurds further up the line of logic fail
  if (update_result === undefined) {
    throw new Error('DJ not in show');
  }

  // -- Add DJ Left to Flowsheet --
  await createLeaveNotification(dj_id, currentShow.id);
  // -------------------------------

  return update_result;
};

const createLeaveNotification = async (dj_id: number, show_id: number): Promise<FSEntry> => {
  let dj_name = 'A DJ';
  const dj: DJ = (await db.select().from(djs).where(eq(djs.id, dj_id)))[0];

  dj_name = dj.dj_name ?? dj_name;

  const message = `${dj_name} left the set!`;

  const notification = await db
    .insert(flowsheet)
    .values({
      show_id: show_id,
      message: message,
    })
    .returning();

  return notification[0];
};

export const getNShows = async (numberOfShows: number = 1, page: number = 0): Promise<Show[]> => {
  return await db
    .select()
    .from(shows)
    .orderBy(desc(shows.id))
    .offset(page * numberOfShows)
    .limit(numberOfShows);
};

export const getLatestShow = async (): Promise<Show> => {
  return (await getNShows(1))[0];
};

export const getOnAirStatusForDJ = async (dj_id: number): Promise<boolean> => {
  const latest_show = await getLatestShow();

  //Avoid a round trip to db with this check
  if (latest_show.end_time !== null) {
    return false;
  }

  const show_djs = await getDJsInShow(latest_show.id, true);

  return show_djs.some((dj) => dj.id == dj_id);
};

export const getDJsInCurrentShow = async (): Promise<DJ[]> => {
  const current_show = await getLatestShow();

  //Avoid a round trip to db with this check
  if (current_show.end_time !== null) {
    return Array(0);
  }

  return getDJsInShow(current_show.id, true);
};

export const getDJsInShow = async (show_id: number, activeOnly: boolean): Promise<DJ[]> => {
  let showDJsInstance: ShowDJ[];
  if (activeOnly) {
    showDJsInstance = await db
      .select()
      .from(show_djs)
      .where(and(eq(show_djs.show_id, show_id), eq(show_djs.active, true)));
  } else {
    showDJsInstance = await db.select().from(show_djs).where(eq(show_djs.show_id, show_id));
  }

  const dj_ids = showDJsInstance.map((dj) => {
    return dj.dj_id;
  });

  return await db.select().from(djs).where(inArray(djs.id, dj_ids));
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

// We use entry_id in order to avoid a race condition here.
// Using the id ensures we are pointing to a specific entry.
export const changeOrder = async (entry_id: number, position_new: number): Promise<FSEntry> => {
  await db.transaction(
    async (trx) => {
      try {
        const position_old = (
          await trx
            .select({
              play_order: flowsheet.play_order,
            })
            .from(flowsheet)
            .where(eq(flowsheet.id, entry_id))
            .limit(1)
        )[0].play_order;

        if (position_new < position_old) {
          await trx
            .update(flowsheet)
            .set({ play_order: sql`play_order + 1` })
            .where(and(gte(flowsheet.play_order, position_new), lte(flowsheet.play_order, position_old - 1)));
        } else if (position_new > position_old) {
          await trx
            .update(flowsheet)
            .set({ play_order: sql`play_order - 1` })
            .where(and(gte(flowsheet.play_order, position_old + 1), lte(flowsheet.play_order, position_new)));
        }

        await trx.update(flowsheet).set({ play_order: position_new }).where(eq(flowsheet.id, entry_id));
      } catch (error) {
        trx.rollback();
        throw error;
      }
    },
    {
      isolationLevel: 'read committed',
      accessMode: 'read write',
      deferrable: true,
    }
  );

  const response = await db.select().from(flowsheet).where(eq(flowsheet.play_order, position_new)).limit(1);

  return response[0];
};

export const getPlaylist = async (show_id: number): Promise<ShowInfo> => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

  const showDJs = (await getDJsInShow(show_id, false)).map((dj) => ({ id: dj.id, dj_name: dj.dj_name }));

  const entries = await db.select().from(flowsheet).where(eq(flowsheet.show_id, show_id));

  let specialty_show_name = '';
  if (show[0].specialty_id != null) {
    const specialty_show = await db.select().from(specialty_shows).where(eq(specialty_shows.id, show[0].specialty_id));
    specialty_show_name = specialty_show[0].specialty_name;
  }

  return {
    ...show[0],
    specialty_show_name: specialty_show_name,
    show_djs: showDJs,
    entries: entries,
  };
};
