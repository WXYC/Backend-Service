import { and, eq, isNull, sql } from 'drizzle-orm';
import { DJQueryParams } from '../controllers/djs.controller.js';
import { db } from '@wxyc/database';
import {
  BinEntry,
  DJ,
  FSEntry,
  NewBinEntry,
  NewDJ,
  artists,
  bins,
  djs,
  flowsheet,
  format,
  genres,
  library,
  show_djs,
  shows,
  specialty_shows,
} from '@wxyc/database';

export const insertDJ = async (new_dj: NewDJ) => {
  const response = await db.insert(djs).values(new_dj).returning();
  return response[0];
};

export const updateDJ = async (new_dj: NewDJ) => {
  if (!new_dj.user_id) {
    throw new Error('user_id is required for update');
  }
  
  const dj_obj = await db
    .update(djs)
    .set(new_dj)
    .where(eq(djs.user_id, new_dj.user_id))
    .returning();

  return dj_obj[0];
};

export const getDJInfoFromDB = async (items: DJQueryParams) /*:Promise<schema.DJ>*/ => {
  let query;
  
  if (items.user_id !== undefined) {
    query = db.select().from(djs).where(eq(djs.user_id, items.user_id));
  } else if (items.real_name !== undefined) {
    query = db.select().from(djs).where(eq(djs.real_name, items.real_name));
  } else if (items.dj_name !== undefined) {
    query = db.select().from(djs).where(eq(djs.dj_name, items.dj_name));
  } else {
    throw new Error('Did not specify a query parameter');
  }

  const dj_obj: DJ[] = await query;
  return dj_obj[0];
};

export const addToBin = async (bin_entry: NewBinEntry): Promise<BinEntry> => {
  const added_bin_entry = await db.insert(bins).values(bin_entry).returning();
  return added_bin_entry[0];
};

export const removeFromBin = async (album_id: number, dj_id: string): Promise<BinEntry> => {
  const removed_bin_entry = await db
    .delete(bins)
    .where(and(eq(bins.dj_id, dj_id), eq(bins.album_id, album_id)))
    .returning();
  return removed_bin_entry[0];
};

export const getBinFromDB = async (dj_id: string) => {
  const dj_bin = await db
    .select({
      album_id: bins.album_id,
      album_title: library.album_title,
      artist_name: artists.artist_name,
      label: library.label,
      code_letters: artists.code_letters,
      code_artist_number: artists.code_artist_number,
      code_number: library.code_number,
      format_name: format.format_name,
      genre_name: genres.genre_name,
    })
    .from(bins)
    .innerJoin(library, eq(bins.album_id, library.id))
    .innerJoin(artists, eq(library.artist_id, artists.id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .where(eq(bins.dj_id, dj_id));

  return dj_bin;
};

type ShowPeek = {
  show: number;
  show_name: string;
  date: Date;
  djs: { dj_id: string; dj_name: string | null }[];
  specialty_show: string;
  preview: FSEntry[];
};

// ERRORS IN SERVICES ARE 500 ERRORS
export const getPlaylistsForDJ = async (dj_id: string) => {
  // gets a 'preview set' of 4 artists/albums and the show id for each show the dj has been in
  const this_djs_shows = await db.select().from(show_djs).where(eq(show_djs.dj_id, dj_id));

  const show_previews = [];
  for (let i = 0; i < this_djs_shows.length; i++) {
    const show = await db.select().from(shows).where(eq(shows.id, this_djs_shows[i].show_id));

    const djs_involved = await db
      .select({ dj_id: show_djs.dj_id, dj_name: djs.dj_name })
      .from(show_djs)
      .innerJoin(djs, and(eq(show_djs.show_id, show[0].id), eq(show_djs.dj_id, djs.id)));

    const peek_object: ShowPeek = {
      show: show[0].id,
      show_name: show[0].show_name ?? '',
      date: show[0].start_time,
      djs: djs_involved,
      specialty_show: '',
      preview: [],
    };

    if (show[0].specialty_id != null) {
      const specialty_show = await db
        .select()
        .from(specialty_shows)
        .where(eq(specialty_shows.id, show[0].specialty_id));
      peek_object.specialty_show = specialty_show[0].specialty_name;
    }

    //get 4 track entries to display in preview
    const entries: FSEntry[] = await db
      .select()
      .from(flowsheet)
      .limit(4)
      .where(and(eq(flowsheet.show_id, show[0].id), isNull(flowsheet.message)));

    peek_object.preview = entries;
    show_previews.push(peek_object);
  }

  return show_previews;
};

export const getPlaylist = async (show_id: number) => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

  const entries = await db.select().from(flowsheet).where(eq(flowsheet.show_id, show_id));

  let specialty_show_name = '';
  if (show[0].specialty_id != null) {
    const specialty_show = await db.select().from(specialty_shows).where(eq(specialty_shows.id, show[0].specialty_id));
    specialty_show_name = specialty_show[0].specialty_name;
  }

  return {
    show_name: show[0].show_name ?? '',
    specialty_show: specialty_show_name,
    date: show[0].start_time,
    entries: entries,
  };
};
