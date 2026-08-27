/**
 * MirrorSQL queries for flowsheet ETL incremental sync mode.
 *
 * Fetches new shows and entries from tubafrenzy's production tables
 * (FLOWSHEET_RADIO_SHOW_PROD, FLOWSHEET_ENTRY_PROD) since the last sync.
 */
import { MirrorSQL, parseTabRow, toNullable } from '@wxyc/database';

// Re-export so existing imports from this module continue to work
export { parseTabRow, toNullable } from '@wxyc/database';

const legacyDB = MirrorSQL.instance();

export type LegacyShowRow = {
  id: number;
  startTime: number;
  endTime: number | null;
  showName: string | null;
  timeLastModified: number;
  // On-air handle (FLOWSHEET_RADIO_SHOW_PROD.DJ_HANDLE). NOT the legal name
  // — that lives in DJ_NAME, which the legacy mirror
  // (shared/legacy-mirror/src/http-mirror.ts) feeds from
  // `auth_user.real_name`, the sole legal-name carrier (PII, see
  // docs/pii.md). Surfacing DJ_NAME on the public v2 wire (via the
  // shows.legacy_dj_name → flowsheet.dj_name COALESCE chain) is the leak we
  // closed by reading DJ_HANDLE instead.
  djHandle: string | null;
  djId: number | null;
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
  timeCreated: number;
  timeLastModified: number;
  legacyReleaseId: number | null;
  // RADIO_HOUR (epoch ms): tubafrenzy's authoritative top-of-hour, only
  // meaningful on breakpoint rows. 0/absent normalizes to null (BS#1449).
  radioHour: number | null;
  segueFlag: number;
};

export const parseShowRows = (raw: string): LegacyShowRow[] => {
  if (raw.trim().length === 0) return [];

  const rows: LegacyShowRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, 7);
    if (!cols) continue;
    const startTime = Number(cols[1]);
    if (!Number.isFinite(startTime) || startTime === 0) continue;
    const rawDjId = Number(cols[6]);
    rows.push({
      id: Number(cols[0]),
      startTime,
      endTime: Number(cols[2]) || null,
      showName: toNullable(cols[3]),
      timeLastModified: Number(cols[4]) || 0,
      djHandle: toNullable(cols[5]),
      djId: Number.isFinite(rawDjId) && rawDjId !== 0 ? rawDjId : null,
    });
  }
  return rows;
};

export const fetchLegacyShows = async (sinceMs: number | null): Promise<LegacyShowRow[]> => {
  const filter = sinceMs != null ? `WHERE rs.SIGNON_TIME > ${sinceMs} OR rs.TIME_LAST_MODIFIED > ${sinceMs}` : '';
  const query = `
    SELECT
      rs.ID,
      rs.SIGNON_TIME,
      rs.SIGNOFF_TIME,
      rs.SHOW_NAME,
      rs.TIME_LAST_MODIFIED,
      REPLACE(REPLACE(IFNULL(rs.DJ_HANDLE, ''), '\\t', ' '), '\\n', ' '),
      rs.DJ_ID
    FROM FLOWSHEET_RADIO_SHOW_PROD rs
    ${filter}
    ORDER BY rs.ID ASC;
  `;
  const raw = await legacyDB.send(query);
  return parseShowRows(raw);
};

/**
 * Parse tab-separated entry rows. Column positions:
 *   0: ID, 1: RADIO_SHOW_ID, 2: ENTRY_TYPE_CODE, 3: ARTIST_NAME,
 *   4: RELEASE_TITLE, 5: SONG_TITLE, 6: LABEL_NAME, 7: REQUEST_FLAG,
 *   8: SEQUENCE_WITHIN_SHOW, 9: START_TIME, 10: TIME_CREATED,
 *   11: TIME_LAST_MODIFIED, 12: LIBRARY_RELEASE_ID, 13: RADIO_HOUR
 *   [, 14: SEGUE_FLAG — optional]
 *
 * RADIO_HOUR (BS#1449) is a stable column; SEGUE_FLAG stays the optional
 * trailing column behind the fetchLegacyEntries try/catch.
 *
 * columnCount: 14 (without SEGUE_FLAG) or 15 (with)
 */
export const parseEntryRows = (raw: string, columnCount: number): LegacyEntryRow[] => {
  if (raw.trim().length === 0) return [];

  const rows: LegacyEntryRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = parseTabRow(line, columnCount);
    if (!cols) {
      console.warn('[flowsheet-etl] Skipping malformed entry row:', line);
      continue;
    }
    const rawReleaseId = Number(cols[12]) || 0;
    const rawRadioHour = Number(cols[13]);
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
      timeCreated: Number(cols[10]) || 0,
      timeLastModified: Number(cols[11]) || 0,
      legacyReleaseId: rawReleaseId === 0 ? null : rawReleaseId,
      radioHour: Number.isFinite(rawRadioHour) && rawRadioHour !== 0 ? rawRadioHour : null,
      segueFlag: columnCount >= 15 ? Number(cols[14]) || 0 : 0,
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
      fe.START_TIME,
      fe.TIME_CREATED,
      fe.TIME_LAST_MODIFIED,
      fe.LIBRARY_RELEASE_ID,
      fe.RADIO_HOUR`;

/**
 * Run a FLOWSHEET_ENTRY_PROD SELECT with the given WHERE-clause filter
 * (already including the `WHERE` keyword, or the empty string for no
 * filter). Tries SEGUE_FLAG first, falling back to the 14-column shape if
 * the column doesn't exist upstream. Shared by `fetchLegacyEntries` (the
 * open-ended `sinceMs` floor used by the incremental sync) and
 * `fetchLegacyEntriesInWindow` (the bounded date-window candidate net used
 * by jobs/flowsheet-april-gap-import, BS#2119) so both stay byte-identical
 * on the column list and the SEGUE_FLAG fallback.
 */
/**
 * Is this the one error the 14-column fallback is for — SEGUE_FLAG genuinely
 * absent upstream (MySQL 1054 / ER_BAD_FIELD_ERROR)?
 *
 * The fallback used to be a blanket `catch {}`. That is safe for the
 * incremental ETL, whose upserts re-read the same rows every 30 minutes, so a
 * transient blip that produced a 14-column read self-heals on the next pass.
 * It is NOT safe for jobs/flowsheet-april-gap-import (BS#2119): that job is
 * insert-only under `ON CONFLICT (legacy_entry_id) DO NOTHING` and is never
 * revisited, so one transient SSH/MySQL failure on the first `send` would
 * write `segue = false` on the entire cohort permanently, signalled only by a
 * `console.warn` its JSON logger never emits and Sentry never sees.
 *
 * So the fallback is narrowed to the condition it was written for, and every
 * other failure propagates to the caller — where the gap import's `runImport`
 * turns it into a `failed` result with a Sentry event, and the ETL's own
 * error handling takes over. A loud failure beats a quietly wrong value.
 *
 * Matched on the message rather than a driver error code because MirrorSQL
 * ships raw text over SSH and does not surface `errno`.
 */
const isMissingSegueFlagColumnError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown column/i.test(message) && /segue_flag/i.test(message);
};

const runEntryQuery = async (filter: string): Promise<LegacyEntryRow[]> => {
  // Try with SEGUE_FLAG first; fall back without it only if the column
  // genuinely doesn't exist upstream (see isMissingSegueFlagColumnError).
  try {
    const queryWithSegue = `SELECT ${BASE_ENTRY_COLUMNS}, fe.SEGUE_FLAG FROM FLOWSHEET_ENTRY_PROD fe ${filter} ORDER BY fe.ID ASC;`;
    const raw = await legacyDB.send(queryWithSegue);
    return parseEntryRows(raw, 15);
  } catch (error) {
    if (!isMissingSegueFlagColumnError(error)) throw error;
    console.warn('[flowsheet-etl] SEGUE_FLAG not available, defaulting to 0.');
    const queryWithout = `SELECT ${BASE_ENTRY_COLUMNS} FROM FLOWSHEET_ENTRY_PROD fe ${filter} ORDER BY fe.ID ASC;`;
    const raw = await legacyDB.send(queryWithout);
    return parseEntryRows(raw, 14);
  }
};

export const fetchLegacyEntries = async (sinceMs: number | null): Promise<LegacyEntryRow[]> => {
  const filter =
    sinceMs != null
      ? `WHERE fe.START_TIME > ${sinceMs} OR fe.TIME_CREATED > ${sinceMs} OR fe.TIME_LAST_MODIFIED > ${sinceMs}`
      : '';
  return runEntryQuery(filter);
};

/**
 * Fetch FLOWSHEET_ENTRY_PROD rows whose START_TIME, TIME_CREATED, or
 * TIME_LAST_MODIFIED falls within `[startMs, endMs)` — a bounded-on-both-ends
 * sibling of `fetchLegacyEntries`'s open-ended `sinceMs` floor. Added for
 * jobs/flowsheet-april-gap-import (BS#2119): the fetch-by-explicit-id-set
 * alternative the extraction plan allows for isn't needed here, since a
 * window this narrow never produces a MySQL `IN (...)` predicate long enough
 * to worry about shipping as raw text over the MirrorSQL SSH channel.
 *
 * Cast deliberately wide — this is the SQL-side candidate net, not the final
 * filter. Most tubafrenzy track entries have `START_TIME = 0` (the #351 root
 * cause this job backfills), so a naive per-column BETWEEN can admit a row
 * whose TRUE resolved timestamp (`resolveEntryTimestamp`'s
 * START_TIME -> TIME_CREATED -> TIME_LAST_MODIFIED fallback) falls outside
 * the window — e.g. a non-zero START_TIME outside the window on a row whose
 * TIME_LAST_MODIFIED happens to land inside it (tubafrenzy bumps
 * TIME_LAST_MODIFIED on adjacent rows during normal operation, per
 * `fetchLegacyEntries`'s own re-emit comment). Callers MUST re-apply
 * `resolveEntryTimestamp` plus an exact `[startMs, endMs)` check to every
 * returned row before treating it as in-window — see
 * jobs/flowsheet-april-gap-import/orchestrate.ts.
 *
 * `startMs`/`endMs` are interpolated as raw SQL literals (MirrorSQL has no
 * parameterized-query path), so both are validated as finite integers here
 * rather than trusting the caller.
 */
export const fetchLegacyEntriesInWindow = async (startMs: number, endMs: number): Promise<LegacyEntryRow[]> => {
  if (!Number.isFinite(startMs) || !Number.isInteger(startMs)) {
    throw new Error(`fetchLegacyEntriesInWindow: startMs must be a finite integer, got ${JSON.stringify(startMs)}`);
  }
  if (!Number.isFinite(endMs) || !Number.isInteger(endMs)) {
    throw new Error(`fetchLegacyEntriesInWindow: endMs must be a finite integer, got ${JSON.stringify(endMs)}`);
  }
  if (endMs <= startMs) {
    throw new Error(`fetchLegacyEntriesInWindow: endMs (${endMs}) must be greater than startMs (${startMs})`);
  }
  const filter = `WHERE (fe.START_TIME BETWEEN ${startMs} AND ${endMs})
       OR (fe.TIME_CREATED BETWEEN ${startMs} AND ${endMs})
       OR (fe.TIME_LAST_MODIFIED BETWEEN ${startMs} AND ${endMs})`;
  return runEntryQuery(filter);
};

export const closeLegacyConnection = () => {
  legacyDB.close();
};
