/**
 * MirrorSQL queries for flowsheet ETL incremental sync mode.
 *
 * Fetches new shows and entries from tubafrenzy since the last sync.
 */
import { MirrorSQL } from '@wxyc/database';

const legacyDB = MirrorSQL.instance();

export type LegacyShowRow = {
  id: number;
  startTime: string;
  endTime: string | null;
};

export type LegacyEntryRow = {
  id: number;
  showId: number;
  entryType: number;
  artistName: string | null;
  albumTitle: string | null;
  trackTitle: string | null;
  label: string | null;
  message: string | null;
  requestFlag: number;
  playOrder: number;
  timePlayed: string;
};

const parseTabRow = (line: string, columnCount: number) => {
  const columns = line.split('\t');
  return columns.length === columnCount ? columns : null;
};

const toNullable = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === 'NULL' ? null : trimmed;
};

export const fetchLegacyShows = async (sinceMs: number | null): Promise<LegacyShowRow[]> => {
  const filter = sinceMs != null ? `WHERE UNIX_TIMESTAMP(ps.START_DATE) * 1000 > ${sinceMs}` : '';
  const query = `
    SELECT
      ps.ID,
      ps.START_DATE,
      ps.END_DATE
    FROM PLAYLIST_SHOW ps
    ${filter}
    ORDER BY ps.ID ASC;
  `;
  const raw = await legacyDB.send(query);
  if (raw.trim().length === 0) return [];

  const rows: LegacyShowRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, 3);
    if (!cols) continue;
    rows.push({
      id: Number(cols[0]),
      startTime: cols[1],
      endTime: toNullable(cols[2]),
    });
  }
  return rows;
};

export const fetchLegacyEntries = async (sinceMs: number | null): Promise<LegacyEntryRow[]> => {
  const filter = sinceMs != null ? `WHERE UNIX_TIMESTAMP(pe.TIME_PLAYED) * 1000 > ${sinceMs}` : '';
  const query = `
    SELECT
      pe.ID,
      pe.PLAYLIST_SHOW_ID,
      pe.ENTRY_TYPE,
      REPLACE(REPLACE(IFNULL(pe.ARTIST_NAME, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(pe.ALBUM_TITLE, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(pe.SONG_TITLE, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(pe.LABEL, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(pe.MESSAGE, ''), '\\t', ' '), '\\n', ' '),
      pe.REQUEST_FLAG,
      pe.PLAY_ORDER,
      pe.TIME_PLAYED
    FROM PLAYLIST_ENTRY pe
    ${filter}
    ORDER BY pe.ID ASC;
  `;
  const raw = await legacyDB.send(query);
  if (raw.trim().length === 0) return [];

  const rows: LegacyEntryRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, 11);
    if (!cols) {
      console.warn('[flowsheet-etl] Skipping malformed entry row:', line);
      continue;
    }
    rows.push({
      id: Number(cols[0]),
      showId: Number(cols[1]),
      entryType: Number(cols[2]) || 0,
      artistName: toNullable(cols[3]),
      albumTitle: toNullable(cols[4]),
      trackTitle: toNullable(cols[5]),
      label: toNullable(cols[6]),
      message: toNullable(cols[7]),
      requestFlag: Number(cols[8]) || 0,
      playOrder: Number(cols[9]) || 0,
      timePlayed: cols[10],
    });
  }
  return rows;
};

export const closeLegacyConnection = () => {
  legacyDB.close();
};
