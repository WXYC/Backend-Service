/**
 * MirrorSQL queries for rotation ETL incremental sync mode.
 *
 * Fetches new and modified rotation releases from tubafrenzy's
 * ROTATION_RELEASE table since the last sync.
 */
import { MirrorSQL, parseTabRow, toNullable } from '@wxyc/database';

const legacyDB = MirrorSQL.instance();

export type LegacyRotationRow = {
  id: number;
  artistName: string | null;
  albumTitle: string | null;
  rotationType: string;
  labelName: string | null;
  addDate: number;
  killDate: number;
  libraryReleaseId: number | null;
  timeLastModified: number;
};

/**
 * Parse tab-separated rotation release rows. Column positions:
 *   0: ID, 1: ARTIST_PRESENTATION_NAME, 2: TITLE, 3: ROTATION_TYPE,
 *   4: LABEL_NAME (COALESCE of COMPANY.NAME and ALTERNATE_LABEL_NAME),
 *   5: ROTATION_ADD_DATE, 6: ROTATION_KILL_DATE, 7: LIBRARY_RELEASE_ID,
 *   8: TIME_LAST_MODIFIED
 */
export const parseRotationRows = (raw: string): LegacyRotationRow[] => {
  if (raw.trim().length === 0) return [];

  const rows: LegacyRotationRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, 9);
    if (!cols) {
      console.warn('[rotation-etl] Skipping malformed rotation row:', line);
      continue;
    }
    const rawLibraryId = Number(cols[7]) || 0;
    rows.push({
      id: Number(cols[0]),
      artistName: toNullable(cols[1]),
      albumTitle: toNullable(cols[2]),
      rotationType: (toNullable(cols[3]) ?? 'N').trim(),
      labelName: toNullable(cols[4]),
      addDate: Number(cols[5]) || 0,
      killDate: Number(cols[6]) || 0,
      libraryReleaseId: rawLibraryId === 0 ? null : rawLibraryId,
      timeLastModified: Number(cols[8]) || 0,
    });
  }
  return rows;
};

export const fetchLegacyRotation = async (sinceMs: number | null): Promise<LegacyRotationRow[]> => {
  const filter = sinceMs != null ? `WHERE rr.TIME_LAST_MODIFIED > ${sinceMs}` : '';
  const query = `
    SELECT
      rr.ID,
      REPLACE(REPLACE(IFNULL(rr.ARTIST_PRESENTATION_NAME, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(rr.TITLE, ''), '\\t', ' '), '\\n', ' '),
      rr.ROTATION_TYPE,
      REPLACE(REPLACE(IFNULL(COALESCE(NULLIF(c.NAME, ''), rr.ALTERNATE_LABEL_NAME), ''), '\\t', ' '), '\\n', ' '),
      rr.ROTATION_ADD_DATE,
      rr.ROTATION_KILL_DATE,
      rr.LIBRARY_RELEASE_ID,
      rr.TIME_LAST_MODIFIED
    FROM ROTATION_RELEASE rr
    LEFT JOIN COMPANY c ON rr.COMPANY_ID = c.ID AND c.NAME != ''
    ${filter}
    ORDER BY rr.ID ASC;
  `;
  const raw = await legacyDB.send(query);
  return parseRotationRows(raw);
};

export const closeLegacyConnection = () => {
  legacyDB.close();
};
