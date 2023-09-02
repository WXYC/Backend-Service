import { eq, isNull } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { FSEntry, flowsheet, show_djs, shows, specialty_shows } from '../db/schema';

export const getPlaylistForDJ = async (dj_id: number) => {
    // gets a 'preview set' of 4 artists/albums and the show id for each show the dj has been in
    let this_djs_shows = await db.select().from(show_djs).where(eq(show_djs.dj_id, dj_id));
  
    let show_previews = [];
    for (let i = 0; i < this_djs_shows.length; i++) {
      let show = await db.select().from(shows).where(eq(shows.id, this_djs_shows[i].show_id));

      let peek_object: {show: number, show_name: string, specialty_show: string, preview: FSEntry[]} = {
        show: show[0].id,
        show_name: show[0].show_name ?? '',
        specialty_show: '',
        preview: [],
      };

      if (show[0].specialty_id != null) {
        let specialty_show = await db.select().from(specialty_shows).where(eq(specialty_shows.id, show[0].specialty_id));
        peek_object.specialty_show = specialty_show[0].specialty_name;
      }

      let start_idx = show[0].flowsheet_start_index ?? -1;
      let end_idx = show[0].flowsheet_end_index ?? -1;
      if (end_idx === -1) {
        continue; // do not include shows that have not been completed
      }
      if (start_idx === -1) {
        show_previews.push(peek_object);
        continue;
      }

      let diff = end_idx - start_idx;
      let limit = Math.min(diff, 4);
  
      let entries: FSEntry[] = await db.select().from(flowsheet).limit(limit).offset(start_idx).where(isNull(flowsheet.message));
      
      peek_object.preview = entries;
      show_previews.push(peek_object);
      
    }
  
    return show_previews;
  };
  
  export const getPlaylist = async (show_id: number) => {
    let show = await db.select().from(shows).where(eq(shows.id, show_id));
  
    let start_idx = show[0].flowsheet_start_index ?? -1;
    let end_idx = show[0].flowsheet_end_index ?? -1;
    if (start_idx === -1 || end_idx === -1) {
      return []; // do not include shows that have not been completed
    }
  
    let diff = end_idx - start_idx;
  
    let entries = await db.select().from(flowsheet).limit(diff).offset(start_idx);
  
    return entries;
  };