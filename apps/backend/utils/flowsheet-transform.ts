/**
 * Flowsheet entry type mapping and text utilities for the webhook receiver.
 *
 * Copied from jobs/flowsheet-etl/transform.ts — keep synchronized if
 * entry type codes or truncation rules change.
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

/** Entry types whose legacy ARTIST_NAME text is display content, not a real artist. */
export const isMessageEntryType = (entryType: string): boolean =>
  entryType === 'breakpoint' || entryType === 'talkset' || entryType === 'message';

/**
 * Truncate a string to a max length, returning null if empty.
 * Matches the VARCHAR(128) / VARCHAR(250) limits in the schema.
 */
export const truncate = (value: string | null | undefined, maxLength: number): string | null => {
  if (!value || value.trim().length === 0) return null;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
};
