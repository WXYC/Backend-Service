/**
 * Data transformers for the flowsheet ETL.
 *
 * Maps tubafrenzy entry types and data shapes to Backend-Service schema.
 * All functions are pure (no side effects) for easy testing.
 */

/**
 * tubafrenzy entry_type codes:
 *   0 = track
 *   1 = show_start
 *   2 = show_end
 *   3 = breakpoint
 *   4 = talkset
 *   5 = dj_join
 *   6 = dj_leave
 *   7 = message (PSA, announcement)
 *   8-10 = reserved (treated as message)
 */
type BackendEntryType =
  | 'track'
  | 'show_start'
  | 'show_end'
  | 'breakpoint'
  | 'talkset'
  | 'dj_join'
  | 'dj_leave'
  | 'message';

const ENTRY_TYPE_MAP: Record<number, BackendEntryType> = {
  0: 'track',
  1: 'show_start',
  2: 'show_end',
  3: 'breakpoint',
  4: 'talkset',
  5: 'dj_join',
  6: 'dj_leave',
  7: 'message',
};

export const mapEntryType = (legacyType: number): BackendEntryType => {
  return ENTRY_TYPE_MAP[legacyType] ?? 'message';
};

/**
 * Convert a MySQL DATETIME string (e.g. '2023-10-15 14:30:00') to a JS Date.
 * tubafrenzy stores times in America/New_York.
 * Returns null if the input is null, empty, or unparseable.
 */
export const parseMySQLDatetime = (datetime: string | null): Date | null => {
  if (!datetime || datetime.trim().length === 0 || datetime === 'NULL') return null;
  const date = new Date(datetime.trim().replace(' ', 'T') + '-04:00');
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Truncate a string to a max length, returning null if empty.
 * Matches the VARCHAR(128) / VARCHAR(250) limits in the schema.
 */
export const truncate = (value: string | null, maxLength: number): string | null => {
  if (!value || value.trim().length === 0) return null;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
};

export type TransformedShow = {
  legacy_show_id: number;
  start_time: Date;
  end_time: Date | null;
};

export type TransformedEntry = {
  legacy_entry_id: number;
  legacy_show_id: number;
  entry_type: BackendEntryType;
  artist_name: string | null;
  album_title: string | null;
  track_title: string | null;
  record_label: string | null;
  message: string | null;
  request_flag: boolean;
  play_order: number;
  add_time: Date;
};

/**
 * Transform a raw show tuple from a MySQL dump into a TransformedShow.
 * Expects columns: [id, start_time, end_time].
 */
export const transformShow = (row: [number, string, string | null]): TransformedShow | null => {
  const startTime = parseMySQLDatetime(row[1]);
  if (!startTime) return null;
  return {
    legacy_show_id: row[0],
    start_time: startTime,
    end_time: parseMySQLDatetime(row[2]),
  };
};

/**
 * Transform a raw entry tuple from a MySQL dump into a TransformedEntry.
 * Expects columns from tubafrenzy PLAYLIST_ENTRY:
 *   [id, show_id, entry_type, artist_name, album_title, track_title, label, message, request_flag, play_order, time_played]
 */
export const transformEntry = (row: (string | number | null)[]): TransformedEntry | null => {
  if (row[0] == null || row[1] == null) return null;
  const entryId = Number(row[0]);
  const showId = Number(row[1]);
  const addTime = parseMySQLDatetime(row[10] as string | null);
  if (!addTime || !Number.isFinite(entryId) || !Number.isFinite(showId)) return null;

  return {
    legacy_entry_id: entryId,
    legacy_show_id: showId,
    entry_type: mapEntryType(Number(row[2]) || 0),
    artist_name: truncate(row[3] as string | null, 128),
    album_title: truncate(row[4] as string | null, 128),
    track_title: truncate(row[5] as string | null, 128),
    record_label: truncate(row[6] as string | null, 128),
    message: truncate(row[7] as string | null, 250),
    request_flag: row[8] === 1 || row[8] === '1' || row[8] === true,
    play_order: Number(row[9]) || 0,
    add_time: addTime,
  };
};
