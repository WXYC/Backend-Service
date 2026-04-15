/**
 * MirrorSQL queries for flowsheet ETL incremental sync mode.
 *
 * Fetches new shows and entries from tubafrenzy's production tables
 * (FLOWSHEET_RADIO_SHOW_PROD, FLOWSHEET_ENTRY_PROD) since the last sync.
 */
import { MirrorSQL } from '@wxyc/database';

const legacyDB = MirrorSQL.instance();

export type LegacyShowRow = {
  id: number;
  startTime: number;
  endTime: number | null;
  showName: string | null;
};

export type LegacyEntryRow = {
  id: number;
  showId: number;
  entryTypeCode: number;
  artistName: string | null;
  albumTitle: string | null;
  trackTitle: string | null;
  label: string | null;
  requestFlag: number;
  playOrder: number;
  startTime: number;
  segueFlag: number;
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
  const filter = sinceMs != null ? `WHERE rs.SIGNON_TIME > ${sinceMs}` : '';
  const query = `
    SELECT
      rs.ID,
      rs.SIGNON_TIME,
      rs.SIGNOFF_TIME,
      rs.SHOW_NAME
    FROM FLOWSHEET_RADIO_SHOW_PROD rs
    ${filter}
    ORDER BY rs.ID ASC;
  `;
  const raw = await legacyDB.send(query);
  if (raw.trim().length === 0) return [];

  const rows: LegacyShowRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, 4);
    if (!cols) continue;
    const startTime = Number(cols[1]);
    if (!Number.isFinite(startTime) || startTime === 0) continue;
    rows.push({
      id: Number(cols[0]),
      startTime,
      endTime: Number(cols[2]) || null,
      showName: toNullable(cols[3]),
    });
  }
  return rows;
};

const parseEntryRows = (raw: string, columnCount: number): LegacyEntryRow[] => {
  if (raw.trim().length === 0) return [];

  const rows: LegacyEntryRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, columnCount);
    if (!cols) {
      console.warn('[flowsheet-etl] Skipping malformed entry row:', line);
      continue;
    }
    rows.push({
      id: Number(cols[0]),
      showId: Number(cols[1]),
      entryTypeCode: Number(cols[2]) || 0,
      artistName: toNullable(cols[3]),
      albumTitle: toNullable(cols[4]),
      trackTitle: toNullable(cols[5]),
      label: toNullable(cols[6]),
      requestFlag: Number(cols[7]) || 0,
      playOrder: Number(cols[8]) || 0,
      startTime: Number(cols[9]),
      segueFlag: columnCount >= 11 ? (Number(cols[10]) || 0) : 0,
    });
  }
  return rows;
};

const BASE_ENTRY_COLUMNS = `
      fe.ID,
      fe.RADIO_SHOW_ID,
      fe.FLOWSHEET_ENTRY_TYPE_CODE_ID,
      REPLACE(REPLACE(IFNULL(fe.ARTIST_NAME, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(fe.RELEASE_TITLE, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(fe.SONG_TITLE, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(fe.LABEL_NAME, ''), '\\t', ' '), '\\n', ' '),
      fe.REQUEST_FLAG,
      fe.SEQUENCE_WITHIN_SHOW,
      fe.START_TIME`;

export const fetchLegacyEntries = async (sinceMs: number | null): Promise<LegacyEntryRow[]> => {
  const filter = sinceMs != null ? `WHERE fe.START_TIME > ${sinceMs}` : '';

  // Try with SEGUE_FLAG first; fall back without it if the column doesn't exist
  try {
    const queryWithSegue = `SELECT ${BASE_ENTRY_COLUMNS}, fe.SEGUE_FLAG FROM FLOWSHEET_ENTRY_PROD fe ${filter} ORDER BY fe.ID ASC;`;
    const raw = await legacyDB.send(queryWithSegue);
    return parseEntryRows(raw, 11);
  } catch {
    console.warn('[flowsheet-etl] SEGUE_FLAG not available, defaulting to 0.');
    const queryWithout = `SELECT ${BASE_ENTRY_COLUMNS} FROM FLOWSHEET_ENTRY_PROD fe ${filter} ORDER BY fe.ID ASC;`;
    const raw = await legacyDB.send(queryWithout);
    return parseEntryRows(raw, 10);
  }
};

export const closeLegacyConnection = () => {
  legacyDB.close();
};
