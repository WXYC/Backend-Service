import { sql, desc, eq, and, lte, gte, inArray } from 'drizzle-orm';
import {
  db,
  FSEntry,
  NewFSEntry,
  Show,
  ShowDJ,
  User,
  shows,
  artists,
  user,
  flowsheet,
  library,
  rotation,
  show_djs,
  library_artist_view,
  specialty_shows,
  album_metadata,
  artist_metadata,
} from '@wxyc/database';
import { IFSEntry, ShowInfo, UpdateRequestBody } from '../controllers/flowsheet.controller.js';
import { PgSelectQueryBuilder, QueryBuilder } from 'drizzle-orm/pg-core';

// Track when the flowsheet was last modified for conditional responses (304 Not Modified)
let lastModifiedAt: Date = new Date();

/** Get the timestamp of the last flowsheet modification */
export const getLastModifiedAt = (): Date => lastModifiedAt;

/** Update the last modified timestamp (call after any write operation) */
const updateLastModified = () => {
  // Truncate to seconds for HTTP Date header compatibility (avoids millisecond precision issues)
  const now = new Date();
  now.setMilliseconds(0);
  // Ensure timestamp advances even for rapid writes within the same second
  if (now.getTime() <= lastModifiedAt.getTime()) {
    lastModifiedAt = new Date(lastModifiedAt.getTime() + 1000);
  } else {
    lastModifiedAt = now;
  }
};

// SQL query fields (flat structure from database)
const FSEntryFieldsRaw = {
  id: flowsheet.id,
  show_id: flowsheet.show_id,
  album_id: flowsheet.album_id,
  entry_type: flowsheet.entry_type,
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
  // Album metadata from cache (will be nested in transform)
  artwork_url: album_metadata.artwork_url,
  discogs_url: album_metadata.discogs_url,
  release_year: album_metadata.release_year,
  spotify_url: album_metadata.spotify_url,
  apple_music_url: album_metadata.apple_music_url,
  youtube_music_url: album_metadata.youtube_music_url,
  bandcamp_url: album_metadata.bandcamp_url,
  soundcloud_url: album_metadata.soundcloud_url,
  // Artist metadata from cache (will be nested in transform)
  artist_bio: artist_metadata.bio,
  artist_wikipedia_url: artist_metadata.wikipedia_url,
};

// Raw result type from SQL query
type FSEntryRaw = {
  id: number;
  show_id: number | null;
  album_id: number | null;
  entry_type: string;
  artist_name: string | null;
  album_title: string | null;
  track_title: string | null;
  record_label: string | null;
  rotation_id: number | null;
  rotation_play_freq: string | null;
  request_flag: boolean | null;
  message: string | null;
  play_order: number | null;
  add_time: Date | null;
  artwork_url: string | null;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
};

/** Transform flat SQL result to nested IFSEntry structure */
const transformToIFSEntry = (raw: FSEntryRaw): IFSEntry => ({
  id: raw.id,
  show_id: raw.show_id,
  album_id: raw.album_id,
  entry_type: raw.entry_type as FSEntry['entry_type'],
  artist_name: raw.artist_name,
  album_title: raw.album_title,
  track_title: raw.track_title,
  record_label: raw.record_label,
  rotation_id: raw.rotation_id,
  rotation_play_freq: raw.rotation_play_freq,
  request_flag: raw.request_flag ?? false,
  message: raw.message,
  play_order: raw.play_order ?? 0,
  add_time: raw.add_time ?? new Date(),
  metadata: {
    artwork_url: raw.artwork_url,
    discogs_url: raw.discogs_url,
    release_year: raw.release_year,
    spotify_url: raw.spotify_url,
    apple_music_url: raw.apple_music_url,
    youtube_music_url: raw.youtube_music_url,
    bandcamp_url: raw.bandcamp_url,
    soundcloud_url: raw.soundcloud_url,
    artist_bio: raw.artist_bio,
    artist_wikipedia_url: raw.artist_wikipedia_url,
  },
});

/** Gets flowsheet entries by page with metadata joins */
export const getEntriesByPage = async (offset: number, limit: number): Promise<IFSEntry[]> => {
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(artist_metadata, eq(artist_metadata.artist_id, library.artist_id))
    .orderBy(desc(flowsheet.play_order))
    .offset(offset)
    .limit(limit);
  return raw.map(transformToIFSEntry);
};

export const getEntriesByRange = async (startId: number, endId: number): Promise<IFSEntry[]> => {
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(artist_metadata, eq(artist_metadata.artist_id, library.artist_id))
    .where(and(gte(flowsheet.id, startId), lte(flowsheet.id, endId)))
    .orderBy(desc(flowsheet.play_order));

  return raw.map(transformToIFSEntry);
};

export const getEntriesByShow = async (...show_ids: number[]): Promise<IFSEntry[]> => {
  if (show_ids.length === 0) return [];

  // Get all entries from these shows
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(artist_metadata, eq(artist_metadata.artist_id, library.artist_id))
    .where(inArray(flowsheet.show_id, show_ids))
    .orderBy(desc(flowsheet.play_order));

  return raw.map(transformToIFSEntry);
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
  updateLastModified();
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
  updateLastModified();
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
  updateLastModified();
  return response[0];
};

export const startShow = async (dj_id: string, show_name?: string, specialty_id?: number): Promise<Show> => {
  const dj_info = (await db.select().from(user).where(eq(user.id, dj_id)).limit(1))[0];

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
    entry_type: 'show_start',
    message: `Start of Show: DJ ${dj_info.djName || dj_info.name} joined the set at ${new Date().toLocaleString(
      'en-US',
      {
        timeZone: 'America/New_York',
      }
    )}`,
  });
  updateLastModified();

  return new_show[0];
};

export const addDJToShow = async (dj_id: string, current_show: Show): Promise<ShowDJ> => {
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

const createJoinNotification = async (id: string, show_id: number): Promise<FSEntry> => {
  let dj_name = 'A DJ';
  const dj = (await db.select().from(user).where(eq(user.id, id)).limit(1))[0];

  dj_name = dj?.djName || dj?.name || dj_name;

  const message = `${dj_name} joined the set!`;

  const notification = await db
    .insert(flowsheet)
    .values({
      show_id: show_id,
      entry_type: 'dj_join',
      message: message,
    })
    .returning();

  updateLastModified();
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
    remaining_djs.map(async (dj: ShowDJ) => {
      await db.update(show_djs).set({ active: false }).where(eq(show_djs.dj_id, dj.dj_id));
      if (dj.dj_id === primary_dj_id) return;
      await createLeaveNotification(dj.dj_id, currentShow.id);
    })
  );

  const dj_information = (await db.select().from(user).where(eq(user.id, primary_dj_id)).limit(1))[0];
  const dj_name = dj_information?.djName || dj_information?.name || 'A DJ';

  await db.insert(flowsheet).values({
    show_id: currentShow.id,
    entry_type: 'show_end',
    message: `End of Show: ${dj_name} left the set at ${new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
    })}`,
  });
  updateLastModified();

  await db.update(shows).set({ end_time: new Date() }).where(eq(shows.id, currentShow.id));

  return await getLatestShow();
};

export const leaveShow = async (dj_id: string, currentShow: Show): Promise<ShowDJ> => {
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

const createLeaveNotification = async (dj_id: string, show_id: number): Promise<FSEntry> => {
  let dj_name = 'A DJ';
  const dj = (await db.select().from(user).where(eq(user.id, dj_id)).limit(1))[0];

  dj_name = dj?.djName || dj?.name || dj_name;

  const message = `${dj_name} left the set!`;

  const notification = await db
    .insert(flowsheet)
    .values({
      show_id: show_id,
      entry_type: 'dj_leave',
      message: message,
    })
    .returning();

  updateLastModified();
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

export const getOnAirStatusForDJ = async (dj_id: string): Promise<boolean> => {
  const latest_show = await getLatestShow();

  //Avoid a round trip to db with this check
  if (latest_show.end_time !== null) {
    return false;
  }

  const show_djs = await getDJsInShow(latest_show.id, true);

  return show_djs.some((dj) => dj.id == dj_id);
};

export const getDJsInCurrentShow = async (): Promise<User[]> => {
  const current_show = await getLatestShow();

  //Avoid a round trip to db with this check
  if (current_show.end_time !== null) {
    return [];
  }

  return getDJsInShow(current_show.id, true);
};

export const getDJsInShow = async (show_id: number, activeOnly: boolean): Promise<User[]> => {
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

  return await db.select().from(user).where(inArray(user.id, dj_ids));
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      artist_id: library.artist_id,
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
    },
    {
      isolationLevel: 'read committed',
      accessMode: 'read write',
      deferrable: true,
    }
  );

  updateLastModified();
  const response = await db.select().from(flowsheet).where(eq(flowsheet.play_order, position_new)).limit(1);

  return response[0];
};

export const getPlaylist = async (show_id: number): Promise<ShowInfo> => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

  const showDJs = (await getDJsInShow(show_id, false)).map((dj) => ({ id: dj.id, dj_name: dj.djName || dj.name }));

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

/**
 * Transform a V1 flowsheet entry to V2 discriminated union format.
 * Removes irrelevant fields based on entry_type for cleaner API responses.
 */
export const transformToV2 = (entry: IFSEntry): Record<string, unknown> => {
  const baseFields = {
    id: entry.id,
    show_id: entry.show_id,
    play_order: entry.play_order,
    add_time: entry.add_time,
    entry_type: entry.entry_type,
  };

  switch (entry.entry_type) {
    case 'track':
      return {
        ...baseFields,
        album_id: entry.album_id,
        rotation_id: entry.rotation_id,
        artist_name: entry.artist_name,
        album_title: entry.album_title,
        track_title: entry.track_title,
        record_label: entry.record_label,
        request_flag: entry.request_flag,
        rotation_play_freq: entry.rotation_play_freq,
        artwork_url: entry.metadata?.artwork_url ?? null,
        discogs_url: entry.metadata?.discogs_url ?? null,
        release_year: entry.metadata?.release_year ?? null,
        spotify_url: entry.metadata?.spotify_url ?? null,
        apple_music_url: entry.metadata?.apple_music_url ?? null,
        youtube_music_url: entry.metadata?.youtube_music_url ?? null,
        bandcamp_url: entry.metadata?.bandcamp_url ?? null,
        soundcloud_url: entry.metadata?.soundcloud_url ?? null,
        artist_bio: entry.metadata?.artist_bio ?? null,
        artist_wikipedia_url: entry.metadata?.artist_wikipedia_url ?? null,
      };

    case 'show_start':
    case 'show_end': {
      // Parse DJ name and timestamp from message
      // Format: "Start of Show: DJ {name} joined the set at {timestamp}"
      // Format: "End of Show: {name} left the set at {timestamp}"
      const message = entry.message || '';
      let dj_name = '';
      let timestamp = '';

      if (entry.entry_type === 'show_start') {
        const match = message.match(/^Start of Show: DJ (.+) joined the set at (.+)$/);
        if (match) {
          dj_name = match[1];
          timestamp = match[2];
        }
      } else {
        const match = message.match(/^End of Show: (.+) left the set at (.+)$/);
        if (match) {
          dj_name = match[1];
          timestamp = match[2];
        }
      }

      return {
        ...baseFields,
        dj_name,
        timestamp,
      };
    }

    case 'dj_join':
    case 'dj_leave': {
      // Parse DJ name from message
      // Format: "{name} joined the set!" or "{name} left the set!"
      const message = entry.message || '';
      let dj_name = '';

      if (entry.entry_type === 'dj_join') {
        const match = message.match(/^(.+) joined the set!$/);
        if (match) {
          dj_name = match[1];
        }
      } else {
        const match = message.match(/^(.+) left the set!$/);
        if (match) {
          dj_name = match[1];
        }
      }

      return {
        ...baseFields,
        dj_name,
      };
    }

    case 'talkset':
    case 'message':
      return {
        ...baseFields,
        message: entry.message,
      };

    case 'breakpoint':
      return {
        ...baseFields,
        message: entry.message,
      };

    default: {
      // Fallback for unknown types - return all fields
      const { metadata, ...rest } = entry;
      return { ...rest, ...metadata } as Record<string, unknown>;
    }
  }
};
