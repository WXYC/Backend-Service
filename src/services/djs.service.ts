import { and, eq, isNull, sql } from 'drizzle-orm';
import { DJQueryParams } from '../controllers/djs.controller';
import { db } from '../db/drizzle_client';
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
} from '../db/schema';

export const insertDJ = async (new_dj: NewDJ) => {
  const response = await db.insert(djs).values(new_dj).returning();
  return response[0];
};

export const getDJInfoFromDB = async (items: DJQueryParams) /*:Promise<schema.DJ>*/ => {
  let query_value: number | string;
  let query_col;
  if (items.dj_id !== undefined) {
    query_value = items.dj_id;
    query_col = djs.id;
  } else if (items.cognito_user_name !== undefined) {
    query_value = items.cognito_user_name;
    query_col = djs.cognito_user_name;
  } else if (items.real_name !== undefined) {
    query_value = items.real_name;
    query_col = djs.real_name;
  } else {
    throw new Error('Did not specify a query parameter');
  }

  const dj_obj: DJ[] = await db
    .select()
    .from(djs)
    .where(sql`${query_col} = ${query_value}`);

  return dj_obj[0];
};

export const addToBin = async (bin_entry: NewBinEntry): Promise<BinEntry> => {
  const added_bin_entry = await db.insert(bins).values(bin_entry).returning();
  return added_bin_entry[0];
};

export const removeFromBin = async (album_id: number, dj_id: number): Promise<BinEntry> => {
  const removed_bin_entry = await db
    .delete(bins)
    .where(and(eq(bins.dj_id, dj_id), eq(bins.album_id, album_id)))
    .returning();
  return removed_bin_entry[0];
};

export const getBinFromDB = async (dj_id: number) => {
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
  djs: string[];
  specialty_show: string;
  preview: FSEntry[];
};

// ERRORS IN SERVICES ARE 500 ERRORS
export const getPlaylistsForDJ = async (dj_id: number) => {
  // gets a 'preview set' of 4 artists/albums and the show id for each show the dj has been in
  const this_djs_shows = await db.select().from(show_djs).where(eq(show_djs.dj_id, dj_id));

  const show_previews = [];
  for (let i = 0; i < this_djs_shows.length; i++) {
    const show = await db.select().from(shows).where(eq(shows.id, this_djs_shows[i].show_id));

    const djs_involved = await db.select().from(show_djs).where(eq(show_djs.show_id, show[0].id));
    const dj_names = [];
    for (let j = 0; j < djs_involved.length; j++) {
      const dj = await db.select().from(djs).where(eq(djs.id, djs_involved[j].dj_id));
      dj[0].dj_name && dj_names.push(dj[0].dj_name);
    }

    const peek_object: ShowPeek = {
      show: show[0].id,
      show_name: show[0].show_name ?? '',
      date: show[0].start_time,
      djs: [],
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

    const start_idx = show[0].flowsheet_start_index ?? -1;
    const end_idx = show[0].flowsheet_end_index ?? -1;
    if (end_idx === -1) {
      continue; // do not include shows that have not been completed
    }
    if (start_idx === -1) {
      show_previews.push(peek_object);
      continue;
    }

    const diff = end_idx - start_idx + 1;
    const limit = Math.min(diff, 4);

    const entries: FSEntry[] = await db
      .select()
      .from(flowsheet)
      .limit(limit)
      .offset(start_idx - 1)
      .where(isNull(flowsheet.message));

    peek_object.preview = entries;
    show_previews.push(peek_object);
  }

  return show_previews;
};

export const getPlaylist = async (show_id: number) => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

  const start_idx = show[0].flowsheet_start_index ?? -1;
  const end_idx = show[0].flowsheet_end_index ?? -1;
  if (start_idx === -1 || end_idx === -1) {
    return []; // do not include shows that have not been completed
  }

  const diff = end_idx - start_idx + 1;

  const entries = await db
    .select()
    .from(flowsheet)
    .limit(diff)
    .offset(start_idx - 1);

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
