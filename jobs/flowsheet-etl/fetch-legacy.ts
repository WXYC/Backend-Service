/**
 * Legacy data fetcher for the flowsheet ETL incremental sync mode.
 *
 * Queries tubafrenzy via MirrorSQL (SSH-based MySQL execution),
 * using the same pattern as the library-etl's fetchLegacyReleases.
 */

import { MirrorSQL } from '@wxyc/database';
import type { RawShow, RawEntry } from './transform.js';

const legacyDB = MirrorSQL.instance();

const parseTabRow = (line: string, columnCount: number): string[] | null => {
  const columns = line.split('\t');
  if (columns.length !== columnCount) return null;
  return columns;
};

/**
 * Fetch shows created in tubafrenzy after the given timestamp.
 */
export async function fetchLegacyShows(lastRunMs: number): Promise<RawShow[]> {
  const sqlQuery = `
    SELECT
      ID,
      SIGNON_TIME,
      SIGNOFF_TIME,
      REPLACE(REPLACE(IFNULL(SHOW_NAME, ''), '\\t', ' '), '\\n', ' ')
    FROM FLOWSHEET_RADIO_SHOW_PROD
    WHERE TIME_CREATED > ${lastRunMs}
    ORDER BY TIME_CREATED ASC;
  `;

  const raw = await legacyDB.send(sqlQuery);
  const rows = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const shows: RawShow[] = [];

  for (const line of rows) {
    const columns = parseTabRow(line, 4);
    if (!columns) {
      console.warn('[flowsheet-etl] Skipping malformed legacy show row:', line);
      continue;
    }

    shows.push({
      id: Number(columns[0]),
      signon_time: Number(columns[1]),
      signoff_time: Number(columns[2]),
      show_name: columns[3],
    });
  }

  return shows;
}

/**
 * Fetch flowsheet entries created in tubafrenzy after the given timestamp.
 * Ordered by TIME_CREATED ASC to preserve chronological order.
 */
export async function fetchLegacyEntries(lastRunMs: number): Promise<RawEntry[]> {
  const sqlQuery = `
    SELECT
      ID,
      REPLACE(REPLACE(IFNULL(ARTIST_NAME, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(SONG_TITLE, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(RELEASE_TITLE, ''), '\\t', ' '), '\\n', ' '),
      IFNULL(LIBRARY_RELEASE_ID, 0),
      REPLACE(REPLACE(IFNULL(LABEL_NAME, ''), '\\t', ' '), '\\n', ' '),
      IFNULL(RADIO_SHOW_ID, 0),
      IFNULL(FLOWSHEET_ENTRY_TYPE_CODE_ID, 0),
      IFNULL(TIME_CREATED, 0),
      IFNULL(REQUEST_FLAG, 0)
    FROM FLOWSHEET_ENTRY_PROD
    WHERE TIME_CREATED > ${lastRunMs}
    ORDER BY TIME_CREATED ASC;
  `;

  const raw = await legacyDB.send(sqlQuery);
  const rows = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const entries: RawEntry[] = [];

  for (const line of rows) {
    const columns = parseTabRow(line, 10);
    if (!columns) {
      console.warn('[flowsheet-etl] Skipping malformed legacy entry row:', line);
      continue;
    }

    entries.push({
      id: Number(columns[0]),
      artist_name: columns[1],
      song_title: columns[2],
      release_title: columns[3],
      library_release_id: Number(columns[4]),
      label_name: columns[5],
      radio_show_id: Number(columns[6]),
      entry_type_code: Number(columns[7]),
      time_created: Number(columns[8]),
      request_flag: Number(columns[9]),
    });
  }

  return entries;
}

export function closeLegacyConnection() {
  legacyDB.close();
}
