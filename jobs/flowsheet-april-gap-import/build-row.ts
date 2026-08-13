/**
 * Pure LegacyEntryRow -> flowsheet insert-row column mapping for
 * jobs/flowsheet-april-gap-import (BS#2119).
 *
 * Mirrors jobs/flowsheet-etl/job.ts's `runIncremental` insert `.values()`
 * shape exactly (BS#351's `resolveEntryTimestamp` fallback + BS#1287's
 * `resolveArtistName` marker handling, `resolveMessage` for the 85
 * talkset/breakpoint rows) — reused rather than forked, per the issue's
 * constraint that reforking `resolveEntryTimestamp` risks reintroducing the
 * bug that created this cohort in the first place.
 *
 * `show_id` / `dj_name` / `album_id` are resolved OUTSIDE this function via
 * pre-insert read-only SELECTs (see orchestrate.ts) and passed in through
 * `BuildRowContext`, keeping this a pure, DB-free mapper — the same
 * separation jobs/flowsheet-etl/transform.ts keeps between mapping and I/O.
 */
import {
  resolveArtistName,
  resolveMessage,
  resolveRadioHour,
  resolveEntryTimestamp,
  mapProdEntryType,
  truncate,
} from '../flowsheet-etl/transform.js';
import type { LegacyEntryRow } from '../flowsheet-etl/fetch-legacy.js';

export type GapImportEntryType =
  'track' | 'show_start' | 'show_end' | 'breakpoint' | 'talkset' | 'dj_join' | 'dj_leave' | 'message';

export type GapImportRow = {
  legacy_entry_id: number;
  legacy_release_id: number | null;
  show_id: number;
  entry_type: GapImportEntryType;
  artist_name: string | null;
  album_title: string | null;
  track_title: string | null;
  record_label: string | null;
  message: string | null;
  request_flag: boolean;
  segue: boolean;
  play_order: number;
  add_time: Date;
  radio_hour: Date | null;
  dj_name: string | null;
  album_id: number | null;
};

export type BuildRowContext = {
  /** Backend shows.id, resolved from the legacy_show_id via jobs/flowsheet-etl/show-id-map.ts. */
  showId: number;
  /** Pre-resolved via a read-only SELECT: COALESCE(user.djName, shows.legacy_dj_name). Never DJ_NAME/auth_user.name (PII). */
  djName: string | null;
  /**
   * Pre-resolved via a read-only SELECT on library.legacy_release_id; null
   * when unlinked (the recurring legacy-linkage-resolve cron, every 30
   * minutes, picks it up later — this is an optimization, not a correctness
   * dependency).
   */
  albumId: number | null;
};

/**
 * Maps one tubafrenzy FLOWSHEET_ENTRY_PROD row (already fetched, e.g. via
 * jobs/flowsheet-etl/fetch-legacy.ts's `fetchLegacyEntriesInWindow`) to a
 * flowsheet insert row. Returns null when `resolveEntryTimestamp` can't
 * resolve any of START_TIME/TIME_CREATED/TIME_LAST_MODIFIED — defensive
 * parity with the donor; should not occur for a row that already passed the
 * date-window candidate filter, which re-applies the same resolution.
 */
export const buildInsertRow = (entry: LegacyEntryRow, ctx: BuildRowContext): GapImportRow | null => {
  const addTime = resolveEntryTimestamp(entry.startTime, entry.timeCreated, entry.timeLastModified);
  if (!addTime) return null;

  const entryType = mapProdEntryType(entry.entryTypeCode);

  return {
    legacy_entry_id: entry.id,
    legacy_release_id: entry.legacyReleaseId,
    show_id: ctx.showId,
    entry_type: entryType,
    artist_name: resolveArtistName(entry.artistName, entryType),
    album_title: truncate(entry.albumTitle, 128),
    track_title: truncate(entry.trackTitle, 128),
    record_label: truncate(entry.label, 128),
    message: resolveMessage(entry.artistName, entryType),
    request_flag: entry.requestFlag === 1,
    segue: entry.segueFlag === 1,
    play_order: entry.playOrder,
    add_time: addTime,
    radio_hour: resolveRadioHour(entryType, entry.radioHour),
    dj_name: ctx.djName,
    album_id: ctx.albumId,
  };
};
