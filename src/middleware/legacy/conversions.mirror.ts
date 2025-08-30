import { FSEntry } from "@/db/schema.js";
import { NewLegacyFlowsheetEntry } from "./schema.mirror.js";

export const convertToLegacy = (entry: FSEntry): NewLegacyFlowsheetEntry => ({
  ARTIST_NAME: entry.artist_name,
  ARTIST_ID: null,
  SONG_TITLE: entry.track_title,
  RELEASE_TITLE: entry.album_title,
});
