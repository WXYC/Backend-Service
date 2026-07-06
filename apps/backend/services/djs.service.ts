import {
  BinEntry,
  FSEntry,
  NewBinEntry,
  artists,
  bins,
  db,
  flowsheet,
  format,
  genre_artist_crossreference,
  genres,
  library,
  show_djs,
  shows,
  specialty_shows,
  user,
} from '@wxyc/database';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { projectFlowsheetEntry, ClientFacingFSEntry } from '../utils/flowsheet-projection.js';

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
      alphabetical_name: artists.alphabetical_name,
      label: library.label,
      code_letters: artists.code_letters,
      code_artist_number: genre_artist_crossreference.artist_genre_code,
      code_number: library.code_number,
      format_name: format.format_name,
      genre_name: genres.genre_name,
    })
    .from(bins)
    .innerJoin(library, eq(bins.album_id, library.id))
    .innerJoin(artists, eq(library.artist_id, artists.id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .where(eq(bins.dj_id, dj_id));

  return dj_bin;
};

type ShowPeek = {
  show: number;
  show_name: string;
  date: Date;
  djs: { dj_id: string; dj_name: string | null }[];
  specialty_show: string;
  // Projected to the client-facing allow-list (BS#1513) so internal flowsheet
  // columns don't ride the peek payload.
  preview: ClientFacingFSEntry[];
};

// ERRORS IN SERVICES ARE 500 ERRORS
export const getPlaylistsForDJ = async (dj_id: string) => {
  const this_djs_shows = await db.select().from(show_djs).where(eq(show_djs.dj_id, dj_id));

  if (this_djs_shows.length === 0) return [];

  const showIds = this_djs_shows.map((s) => s.show_id);

  const allShows = await db.select().from(shows).where(inArray(shows.id, showIds));

  const allDjs = await db
    .select({ dj_id: show_djs.dj_id, dj_name: user.djName, show_id: show_djs.show_id })
    .from(show_djs)
    .innerJoin(user, eq(show_djs.dj_id, user.id))
    .where(inArray(show_djs.show_id, showIds));

  const specialtyIds = allShows.filter((s) => s.specialty_id != null).map((s) => s.specialty_id!);

  const allSpecialties =
    specialtyIds.length > 0
      ? await db.select().from(specialty_shows).where(inArray(specialty_shows.id, specialtyIds))
      : [];

  const allEntries: FSEntry[] = await db
    .select()
    .from(flowsheet)
    .where(and(inArray(flowsheet.show_id, showIds), isNull(flowsheet.message)))
    // Deterministic preview: without an ORDER BY the 4-row slice below is
    // arbitrary heap order (enrichment UPDATEs relocate tuples), not show order.
    .orderBy(flowsheet.play_order);

  const specialtyMap = new Map(allSpecialties.map((s) => [s.id, s.specialty_name]));
  const djsByShow = new Map<number, { dj_id: string; dj_name: string | null }[]>();
  for (const dj of allDjs) {
    const list = djsByShow.get(dj.show_id) ?? [];
    list.push({ dj_id: dj.dj_id, dj_name: dj.dj_name });
    djsByShow.set(dj.show_id, list);
  }
  const entriesByShow = new Map<number, FSEntry[]>();
  for (const entry of allEntries) {
    if (entry.show_id == null) continue;
    const list = entriesByShow.get(entry.show_id) ?? [];
    list.push(entry);
    entriesByShow.set(entry.show_id, list);
  }

  return allShows.map((show) => {
    const preview = (entriesByShow.get(show.id) ?? []).slice(0, 4).map(projectFlowsheetEntry);
    return {
      show: show.id,
      show_name: show.show_name ?? '',
      date: show.start_time,
      djs: djsByShow.get(show.id) ?? [],
      specialty_show: specialtyMap.get(show.specialty_id!) ?? '',
      preview,
    } satisfies ShowPeek;
  });
};
