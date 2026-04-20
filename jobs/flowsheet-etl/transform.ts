/**
 * Data transformers for the flowsheet ETL.
 *
 * Maps tubafrenzy entry types and data shapes to Backend-Service schema.
 * All functions are pure (no side effects) for easy testing.
 */

// Import shared utilities for local use and re-export so existing imports continue to work
import { epochMsToDate as _epochMsToDate, truncate as _truncate } from '@wxyc/database';
export const epochMsToDate = _epochMsToDate;
export const truncate = _truncate;

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
 * FLOWSHEET_ENTRY_TYPE_CODE_ID codes (production FLOWSHEET_ENTRY_PROD table):
 *   0 = OTHER (non-rotation track)
 *   1-4 = HEAVY/MEDIUM/LIGHT/SINGLES (rotation tracks)
 *   5 = NEW (new vinyl, not yet in rotation)
 *   6 = LIBRARY (existing library release)
 *   7 = TALKSET
 *   8 = HOURLY_BREAK
 *   9 = START_OF_SHOW
 *   10 = END_OF_SHOW
 */
const PROD_ENTRY_TYPE_MAP: Record<number, BackendEntryType> = {
  0: 'track',
  1: 'track',
  2: 'track',
  3: 'track',
  4: 'track',
  5: 'track',
  6: 'track',
  7: 'talkset',
  8: 'breakpoint',
  9: 'show_start',
  10: 'show_end',
};

export const mapProdEntryType = (typeCode: number): BackendEntryType => {
  return PROD_ENTRY_TYPE_MAP[typeCode] ?? 'message';
};

/**
 * Resolve the UTC offset for America/New_York at a given instant.
 * Returns a string like "-05:00" (EST) or "-04:00" (EDT).
 */
const easternOffsetAt = (probeUtc: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(probeUtc);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  // tz is "GMT-5" or "GMT-4"; normalize to "-05:00" / "-04:00"
  const hours = parseInt(tz.replace('GMT', ''), 10);
  const sign = hours <= 0 ? '-' : '+';
  return `${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`;
};

/**
 * Convert a MySQL DATETIME string (e.g. '2023-10-15 14:30:00') to a JS Date.
 * tubafrenzy stores times as America/New_York wall-clock values with no
 * offset, so we determine whether EST or EDT applies for the given date and
 * append the correct offset before parsing.
 * Returns null if the input is null, empty, or unparseable.
 */
export const parseMySQLDatetime = (datetime: string | null): Date | null => {
  if (!datetime || datetime.trim().length === 0 || datetime === 'NULL') return null;
  const isoString = datetime.trim().replace(' ', 'T');
  // First pass: treat the wall-clock time as UTC to probe the Eastern offset
  const probeUtc = new Date(isoString + 'Z');
  if (Number.isNaN(probeUtc.getTime())) return null;
  const offset1 = easternOffsetAt(probeUtc);
  const date1 = new Date(isoString + offset1);
  // Second pass: the first result is the true UTC instant (within 1 hour);
  // re-probe to handle the edge case near DST transitions where the UTC
  // probe date falls on the wrong side of the boundary.
  const offset2 = easternOffsetAt(date1);
  if (offset2 !== offset1) {
    const date2 = new Date(isoString + offset2);
    return Number.isNaN(date2.getTime()) ? null : date2;
  }
  return Number.isNaN(date1.getTime()) ? null : date1;
};

// epochMsToDate is re-exported from @wxyc/database above

/**
 * Resolve the best available timestamp for a FLOWSHEET_ENTRY_PROD row.
 * Prefers START_TIME (epoch ms), falls back to TIME_CREATED, then TIME_LAST_MODIFIED.
 * Most track entries have START_TIME = 0, so the fallback is essential.
 */
export const resolveEntryTimestamp = (
  startTime: number | null,
  timeCreated: number | null,
  timeLastModified: number | null
): Date | null => {
  return epochMsToDate(startTime) ?? epochMsToDate(timeCreated) ?? epochMsToDate(timeLastModified);
};

/**
 * Extract the DJ name from a START/END OF SHOW message in FLOWSHEET_ENTRY_PROD.
 * These entries store structured text in the ARTIST_NAME column:
 *   "START OF SHOW: DJ Bluejay SIGNED ON at 12:03 PM (4/4/26)"
 *   "END OF SHOW: dj wilde SIGNED OFF at 12:03 PM (4/4/26)"
 * Returns the DJ name or null if the text doesn't match the pattern.
 */
export const parseShowEntryDJName = (artistName: string): string | null => {
  const match = artistName.match(/^(?:START|END) OF SHOW: (.+?) SIGNED (?:ON|OFF)/);
  return match ? match[1] : null;
};

// truncate is re-exported from @wxyc/database above

export type TransformedShow = {
  legacy_show_id: number;
  start_time: Date;
  end_time: Date | null;
  show_name: string | null;
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
  segue: boolean;
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
    show_name: null,
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
    request_flag: row[8] === 1 || row[8] === '1',
    segue: false,
    play_order: Number(row[9]) || 0,
    add_time: addTime,
  };
};
