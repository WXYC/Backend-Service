import {
  BinEntry,
  FSEntry,
  NewBinEntry,
  artists,
  bins,
  db,
  flowsheet,
  format,
  genres,
  library,
  show_djs,
  shows,
  specialty_shows,
  user,
} from '@wxyc/database';
import { and, eq, isNull } from 'drizzle-orm';

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
      .select({ dj_id: show_djs.dj_id, dj_name: user.djName })
      .from(show_djs)
      .innerJoin(user, and(eq(show_djs.show_id, show[0].id), eq(show_djs.dj_id, user.id)));

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
