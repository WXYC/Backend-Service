/**
 * Flowsheet Entry Types - Discriminated Union for V2 API
 *
 * Entry types represent different kinds of flowsheet entries:
 * - track: Song play
 * - show_start: Show begins
 * - show_end: Show ends
 * - dj_join: DJ joins show
 * - dj_leave: DJ leaves show
 * - talkset: DJ talk segment (announcements, station ID, etc.)
 * - breakpoint: Hour marker (top of hour transitions)
 * - message: Custom message (arbitrary user text)
 */

export type FlowsheetEntryType =
  | 'track'
  | 'show_start'
  | 'show_end'
  | 'dj_join'
  | 'dj_leave'
  | 'talkset'
  | 'breakpoint'
  | 'message';

/** Base fields shared by all entry types */
interface BaseEntry {
  id: number;
  show_id: number | null;
  play_order: number;
  add_time: Date;
}

/** Track entry - a song that was played */
export interface TrackEntryV2 extends BaseEntry {
  entry_type: 'track';
  album_id: number | null;
  rotation_id: number | null;
  artist_name: string | null;
  album_title: string | null;
  track_title: string | null;
  record_label: string | null;
  request_flag: boolean;
  rotation_bin: string | null;
  // Album metadata from cache
  artwork_url: string | null;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  // Artist metadata from cache
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
}

/** Show start event - when a show begins */
export interface ShowStartEntryV2 extends BaseEntry {
  entry_type: 'show_start';
  dj_name: string;
  timestamp: string;
}

/** Show end event - when a show ends */
export interface ShowEndEntryV2 extends BaseEntry {
  entry_type: 'show_end';
  dj_name: string;
  timestamp: string;
}

/** DJ join event - when a DJ joins an active show */
export interface DJJoinEntryV2 extends BaseEntry {
  entry_type: 'dj_join';
  dj_name: string;
}

/** DJ leave event - when a DJ leaves an active show */
export interface DJLeaveEntryV2 extends BaseEntry {
  entry_type: 'dj_leave';
  dj_name: string;
}

/** Talkset entry - DJ talk segment, announcements, station ID */
export interface TalksetEntryV2 extends BaseEntry {
  entry_type: 'talkset';
  message: string;
}

/** Breakpoint entry - hour marker, top of hour transitions */
export interface BreakpointEntryV2 extends BaseEntry {
  entry_type: 'breakpoint';
  message: string | null;
}

/** Message entry - custom/arbitrary message */
export interface MessageEntryV2 extends BaseEntry {
  entry_type: 'message';
  message: string;
}

/** Union type of all V2 flowsheet entries */
export type FlowsheetEntryV2 =
  | TrackEntryV2
  | ShowStartEntryV2
  | ShowEndEntryV2
  | DJJoinEntryV2
  | DJLeaveEntryV2
  | TalksetEntryV2
  | BreakpointEntryV2
  | MessageEntryV2;
