/**
 * Data transformation functions for the flowsheet ETL.
 *
 * Shared by both bulk load and incremental sync modes.
 * Maps tubafrenzy field names and type codes to Backend-Service schema values.
 */

export type RawShow = {
  id: number;
  signon_time: number;
  signoff_time: number;
  show_name: string;
};

export type RawEntry = {
  id: number;
  radio_show_id: number;
  entry_type_code: number;
  artist_name: string;
  song_title: string;
  release_title: string;
  label_name: string;
  library_release_id: number;
  request_flag: number;
  time_created: number;
};

export type TransformedShow = {
  legacy_show_id: number;
  start_time: Date;
  end_time: Date | null;
  show_name: string | null;
  primary_dj_id: null;
  specialty_id: null;
};

export type TransformedEntry = {
  legacy_entry_id: number;
  show_id: null; // resolved separately by caller
  album_id: number | null;
  rotation_id: null;
  label_id: null;
  entry_type: string;
  artist_name: string | null;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  request_flag: boolean;
  message: string | null;
  add_time: Date;
};

const ENTRY_TYPE_MAP: Record<number, string> = {
  7: 'talkset',
  8: 'breakpoint',
  9: 'show_start',
  10: 'show_end',
};

const TRACK_CODES = new Set([0, 1, 2, 3, 4, 5, 6]);

const NON_TRACK_CODES = new Set([7, 8, 9, 10]);

/**
 * Map a tubafrenzy FLOWSHEET_ENTRY_TYPE_CODE_ID to a Backend entry_type string.
 *
 * Codes 1-4 (rotation bins), 6 (library), and 0 (manual) all map to 'track'.
 * Code 7 = talkset, 8 = breakpoint, 9 = show_start, 10 = show_end.
 * Unmapped codes default to 'track' with a console warning.
 */
export function mapEntryType(code: number): string {
  if (ENTRY_TYPE_MAP[code]) return ENTRY_TYPE_MAP[code];
  if (!TRACK_CODES.has(code)) {
    console.warn(`[flowsheet-etl] Unmapped entry type code: ${code}, defaulting to 'track'`);
  }
  return 'track';
}

/**
 * Transform a raw tubafrenzy show row to Backend-Service show format.
 */
export function transformShow(raw: RawShow): TransformedShow {
  const showName = raw.show_name?.trim();
  return {
    legacy_show_id: raw.id,
    start_time: new Date(raw.signon_time),
    end_time: raw.signoff_time > 0 ? new Date(raw.signoff_time) : null,
    show_name: showName && showName.length > 0 ? truncate(showName, 128) : null,
    primary_dj_id: null,
    specialty_id: null,
  };
}

/**
 * Transform a raw tubafrenzy flowsheet entry to Backend-Service format.
 *
 * For non-track entries (talkset, breakpoint, show_start, show_end),
 * the ARTIST_NAME field contains the message text.
 */
export function transformEntry(raw: RawEntry, legacyReleaseMap: Map<number, number>): TransformedEntry {
  const entryType = mapEntryType(raw.entry_type_code);
  const isNonTrack = NON_TRACK_CODES.has(raw.entry_type_code);

  const albumId = raw.library_release_id > 0 ? (legacyReleaseMap.get(raw.library_release_id) ?? null) : null;

  if (isNonTrack) {
    return {
      legacy_entry_id: raw.id,
      show_id: null,
      album_id: null,
      rotation_id: null,
      label_id: null,
      entry_type: entryType,
      artist_name: null,
      track_title: null,
      album_title: null,
      record_label: null,
      request_flag: false,
      message: truncate(raw.artist_name, 250) ?? null,
      add_time: new Date(raw.time_created),
    };
  }

  return {
    legacy_entry_id: raw.id,
    show_id: null,
    album_id: albumId,
    rotation_id: null,
    label_id: null,
    entry_type: entryType,
    artist_name: truncate(raw.artist_name, 128),
    track_title: truncate(raw.song_title, 128),
    album_title: truncate(raw.release_title, 128),
    record_label: truncate(raw.label_name, 128),
    request_flag: raw.request_flag === 1,
    message: null,
    add_time: new Date(raw.time_created),
  };
}

/**
 * Truncate a string to maxLen characters. Returns null for empty/null input.
 * Logs a warning when truncation occurs.
 */
export function truncate(str: string | null | undefined, maxLen: number): string | null {
  if (str == null || str.length === 0) return null;
  if (str.length <= maxLen) return str;
  console.warn(`[flowsheet-etl] Truncating string from ${str.length} to ${maxLen} chars: "${str.slice(0, 40)}..."`);
  return str.slice(0, maxLen);
}
