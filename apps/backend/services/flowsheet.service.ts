import { sql, desc, eq, and, lte, gte, inArray } from 'drizzle-orm';
import WxycError from '../utils/error.js';
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
} from '@wxyc/database';
import { IFSEntry, ShowInfo, ShowMetadata, UpdateRequestBody } from '../controllers/flowsheet.controller.js';
import { PgSelectQueryBuilder, QueryBuilder } from 'drizzle-orm/pg-core';

// Track when the flowsheet was last modified for conditional responses (304 Not Modified)
let lastModifiedAt: Date = new Date();

/**
 * Compute the next play_order value for a new flowsheet entry within a given
 * show. play_order is manually managed (not a serial/sequence) and is scoped
 * per show — tubafrenzy's webhook writes per-show play_orders (1, 2, 3, ...)
 * and Backend-Service inserts must continue that sequence rather than picking
 * up the global table max. Without the `WHERE show_id = ?` predicate a brand
 * new track in show B would inherit `max + 1` from a prior show A's late
 * additions, producing the discontinuous play_order sequence that breaks
 * dj-site's optimistic update + cache reconciliation (#693).
 */
const nextPlayOrder = async (showId: number): Promise<number> => {
  const result = await db
    .select({ max: sql<number>`coalesce(max(${flowsheet.play_order}), 0)` })
    .from(flowsheet)
    .where(eq(flowsheet.show_id, showId));
  return result[0].max + 1;
};

/** Get the timestamp of the last flowsheet modification */
export const getLastModifiedAt = (): Date => lastModifiedAt;

/** Update the last modified timestamp (call after any write operation) */
export const updateLastModified = () => {
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
  track_position: flowsheet.track_position,
  record_label: flowsheet.record_label,
  label_id: flowsheet.label_id,
  rotation_id: flowsheet.rotation_id,
  rotation_bin: rotation.rotation_bin,
  request_flag: flowsheet.request_flag,
  segue: flowsheet.segue,
  message: flowsheet.message,
  play_order: flowsheet.play_order,
  legacy_entry_id: flowsheet.legacy_entry_id,
  legacy_release_id: flowsheet.legacy_release_id,
  add_time: flowsheet.add_time,
  dj_name: flowsheet.dj_name,
  linkage_source: flowsheet.linkage_source,
  linkage_confidence: flowsheet.linkage_confidence,
  linked_at: flowsheet.linked_at,
  // Metadata (inline on flowsheet, will be nested in transform)
  artwork_url: flowsheet.artwork_url,
  discogs_url: flowsheet.discogs_url,
  release_year: flowsheet.release_year,
  spotify_url: flowsheet.spotify_url,
  apple_music_url: flowsheet.apple_music_url,
  youtube_music_url: flowsheet.youtube_music_url,
  bandcamp_url: flowsheet.bandcamp_url,
  soundcloud_url: flowsheet.soundcloud_url,
  artist_bio: flowsheet.artist_bio,
  artist_wikipedia_url: flowsheet.artist_wikipedia_url,
  on_streaming: library.on_streaming,
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
  track_position: string | null;
  record_label: string | null;
  label_id: number | null;
  rotation_id: number | null;
  rotation_bin: string | null;
  request_flag: boolean | null;
  segue: boolean | null;
  message: string | null;
  play_order: number | null;
  legacy_entry_id: number | null;
  legacy_release_id: number | null;
  add_time: Date | null;
  dj_name: string | null;
  linkage_source: string | null;
  linkage_confidence: number | null;
  linked_at: Date | null;
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
  on_streaming: boolean | null;
};

/** Transform flat SQL result to nested IFSEntry structure */
const transformToIFSEntry = (raw: FSEntryRaw): IFSEntry => ({
  id: raw.id,
  show_id: raw.show_id,
  album_id: raw.album_id,
  legacy_entry_id: raw.legacy_entry_id ?? null,
  legacy_release_id: raw.legacy_release_id ?? null,
  entry_type: raw.entry_type as FSEntry['entry_type'],
  artist_name: raw.artist_name,
  album_title: raw.album_title,
  track_title: raw.track_title,
  track_position: raw.track_position,
  record_label: raw.record_label,
  label_id: raw.label_id,
  rotation_id: raw.rotation_id,
  rotation_bin: raw.rotation_bin,
  request_flag: raw.request_flag ?? false,
  segue: raw.segue ?? false,
  message: raw.message,
  play_order: raw.play_order ?? 0,
  add_time: raw.add_time ?? new Date(),
  dj_name: raw.dj_name,
  linkage_source: raw.linkage_source,
  linkage_confidence: raw.linkage_confidence,
  linked_at: raw.linked_at,
  // Metadata columns (on FSEntry since they're on the flowsheet table)
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
  on_streaming: raw.on_streaming ?? null,
  // Nested metadata view (used by transformToV2)
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

/**
 * Resolve the DJ name for a show using the same priority as the search
 * service's DJ_NAME_EXPR and migration 0053:
 *   COALESCE(auth_user.dj_name, shows.legacy_dj_name, auth_user.name).
 *
 * Used by the live insert path (step 5b.2) to denormalize the resolved value
 * onto each new flowsheet row so search no longer needs to join shows -> auth_user.
 */
export const resolveDjNameForShow = async (show: Show): Promise<string | null> => {
  const legacy = (show.legacy_dj_name as string | null | undefined) ?? null;
  const primaryDjId = (show.primary_dj_id as string | null | undefined) ?? null;

  if (primaryDjId == null) return legacy;

  const rows = await db
    .select({ djName: user.djName, name: user.name })
    .from(user)
    .where(eq(user.id, primaryDjId))
    .limit(1);
  const dj = rows[0];
  return dj?.djName ?? legacy ?? dj?.name ?? null;
};

/**
 * Estimate total flowsheet entries for pagination.
 *
 * Reads `pg_class.reltuples`, the planner's row-count estimate maintained by
 * autovacuum/ANALYZE. Constant-time vs. an exact `count(*)` which would
 * sequentially scan ~2.6M rows and routinely exceed the 5s per-statement
 * timeout on this RDS instance — that's the immediate cause of
 * `/flowsheet?page=0&limit=20` 500ing under live load. The estimate is
 * typically within a few hundred of the true count, which is fine for a
 * paginated UI's "Page X of N" display; pages near the upper bound may shift
 * by one as autovacuum lags.
 *
 * `reltuples = -1` is the "never analyzed" sentinel; treat it as 0. The same
 * goes for a missing row (no permissions on `pg_class` would surface as an
 * error from the surrounding query, not as a missing row).
 *
 * Re-evaluation trigger: revisit when `flowsheet` exceeds ~5M rows (currently
 * ~2.6M). At that scale the ±1% planner estimate drifts ±50k per page bucket
 * and the UI's "Page X of N" starts skipping numbers visibly. Alternatives at
 * that point, cheapest to costliest: (1) drop `totalPages` from the response
 * and let clients infer "more pages?" from `results.length === limit`,
 * (2) refresh a materialized count on a cron, (3) bump the RDS instance class
 * so an exact `COUNT(*)` fits the 5s statement timeout. (Storage size bumps
 * are not on the table — gp3 conversions are reversible, sizing up is not.)
 */
export const getEntryCount = async (): Promise<number> => {
  const schema = process.env.WXYC_SCHEMA_NAME ?? 'wxyc_schema';
  const result = await db.execute(
    sql`SELECT GREATEST(reltuples::bigint, 0)::int AS count
        FROM pg_class
        WHERE relname = 'flowsheet'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${schema})`
  );
  const row = (result as unknown as Array<{ count: number }>)[0];
  return Number(row?.count ?? 0);
};

/** Gets flowsheet entries by page with metadata joins */
export const getEntriesByPage = async (offset: number, limit: number): Promise<IFSEntry[]> => {
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .orderBy(desc(flowsheet.id))
    .offset(offset)
    .limit(limit);
  return raw.map(transformToIFSEntry);
};

export const getEntriesByRange = async (startId: number, endId: number): Promise<IFSEntry[]> => {
  // play_order is per-show after #693; id is globally monotonic across shows.
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .where(and(gte(flowsheet.id, startId), lte(flowsheet.id, endId)))
    .orderBy(desc(flowsheet.id));

  return raw.map(transformToIFSEntry);
};

export const getEntriesByShow = async (...show_ids: number[]): Promise<IFSEntry[]> => {
  if (show_ids.length === 0) return [];

  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .where(inArray(flowsheet.show_id, show_ids))
    .orderBy(desc(flowsheet.play_order));

  return raw.map(transformToIFSEntry);
};

export const addTrack = async (entry: Omit<NewFSEntry, 'play_order'>): Promise<FSEntry> => {
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

  if (entry.show_id == null) {
    throw new WxycError('Cannot add flowsheet entry without show_id', 400);
  }
  const play_order = await nextPlayOrder(entry.show_id);
  const response = await db
    .insert(flowsheet)
    .values({ ...entry, play_order })
    .returning();
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

  if (!dj_info) {
    throw new WxycError(`DJ with id '${dj_id}' not found`, 404);
  }

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
    play_order: await nextPlayOrder(new_show[0].id),
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
      play_order: await nextPlayOrder(show_id),
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
    play_order: await nextPlayOrder(currentShow.id),
    message: `End of Show: ${dj_name} left the set at ${new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
    })}`,
  });
  updateLastModified();

  await db.update(shows).set({ end_time: new Date() }).where(eq(shows.id, currentShow.id));

  // We just ended this show, so a latest show always exists here
  return (await getLatestShow())!;
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
    throw new WxycError('Bad Request: DJ not a member of show', 400);
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
      play_order: await nextPlayOrder(show_id),
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

export const getLatestShow = async (): Promise<Show | undefined> => {
  return (await getNShows(1))[0];
};

export const getOnAirStatusForDJ = async (dj_id: string): Promise<boolean> => {
  const latest_show = await getLatestShow();
  if (!latest_show || latest_show.end_time !== null) {
    return false;
  }

  const show_djs = await getDJsInShow(latest_show.id, true);
  return show_djs.some((dj) => dj.id == dj_id);
};

export const getDJsInCurrentShow = async (): Promise<User[]> => {
  const current_show = await getLatestShow();
  if (!current_show || current_show.end_time !== null) {
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
      label_id: library.label_id,
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
      const result = await trx
        .select({
          play_order: flowsheet.play_order,
          show_id: flowsheet.show_id,
        })
        .from(flowsheet)
        .where(eq(flowsheet.id, entry_id))
        .limit(1);

      if (result.length === 0) {
        throw new WxycError(`Flowsheet entry ${entry_id} not found`, 404);
      }

      const position_old = result[0].play_order;
      const show_id = result[0].show_id;

      // Defensive: every flowsheet row has show_id post-#693. Be loud, not
      // silent, if the invariant ever breaks — an unscoped bump UPDATE
      // (#712) corrupts cross-show play_order ranges in ways that don't
      // surface until much later.
      if (show_id == null) {
        throw new WxycError(`Flowsheet entry ${entry_id} has no show_id`, 500);
      }

      if (position_new < position_old) {
        await trx
          .update(flowsheet)
          .set({ play_order: sql`play_order + 1` })
          .where(
            and(
              eq(flowsheet.show_id, show_id),
              gte(flowsheet.play_order, position_new),
              lte(flowsheet.play_order, position_old - 1)
            )
          );
      } else if (position_new > position_old) {
        await trx
          .update(flowsheet)
          .set({ play_order: sql`play_order - 1` })
          .where(
            and(
              eq(flowsheet.show_id, show_id),
              gte(flowsheet.play_order, position_old + 1),
              lte(flowsheet.play_order, position_new)
            )
          );
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
  // Filter by id, not play_order — post-#693 multiple shows legitimately
  // share play_order values, so `WHERE play_order = ? LIMIT 1` could
  // surface a row from a different show.
  const response = await db.select().from(flowsheet).where(eq(flowsheet.id, entry_id)).limit(1);

  return response[0];
};

/** Gets show metadata (DJs, specialty show name) without fetching entries */
export const getShowMetadata = async (show_id: number): Promise<ShowMetadata> => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

  const showDJs = (await getDJsInShow(show_id, false)).map((dj) => ({ id: dj.id, dj_name: dj.djName || dj.name }));

  let specialty_show_name = '';
  if (show[0].specialty_id != null) {
    const specialty_show = await db.select().from(specialty_shows).where(eq(specialty_shows.id, show[0].specialty_id));
    specialty_show_name = specialty_show[0].specialty_name;
  }

  return {
    ...show[0],
    specialty_show_name: specialty_show_name,
    show_djs: showDJs,
  };
};

export const getPlaylist = async (show_id: number): Promise<ShowInfo> => {
  const [metadata, entries] = await Promise.all([
    getShowMetadata(show_id),
    db.select().from(flowsheet).where(eq(flowsheet.show_id, show_id)),
  ]);

  return {
    ...metadata,
    entries,
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

  // dj_name is intentionally not propagated here. It is denormalized onto the
  // flowsheet row purely to let the search service skip the shows -> auth_user
  // join (steps 5b.1-5b.3); V2 API consumers should keep deriving the display
  // name from the show metadata so this denormalization stays an internal
  // implementation detail of the search path.
  switch (entry.entry_type) {
    case 'track':
      return {
        ...baseFields,
        album_id: entry.album_id,
        rotation_id: entry.rotation_id,
        artist_name: entry.artist_name,
        album_title: entry.album_title,
        track_title: entry.track_title,
        track_position: entry.track_position ?? null,
        record_label: entry.record_label,
        label_id: entry.label_id,
        request_flag: entry.request_flag,
        segue: entry.segue,
        rotation_bin: entry.rotation_bin,
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
        on_streaming: entry.on_streaming ?? null,
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
      return { ...rest, ...metadata };
    }
  }
};
