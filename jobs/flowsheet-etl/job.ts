/**
 * Flowsheet ETL: Import and sync flowsheet data from tubafrenzy.
 *
 * Two modes:
 * - Bulk load: Parse a mysqldump file and insert shows + entries in batches
 * - Incremental: Query tubafrenzy via MirrorSQL for new data since last run
 *
 * Source tables: FLOWSHEET_RADIO_SHOW_PROD, FLOWSHEET_ENTRY_PROD
 *
 * Usage:
 *   node dist/job.js /path/to/dump.sql [--force]   # bulk load
 *   node dist/job.js                                # incremental sync
 */

import { readFileSync } from 'fs';
import { eq, sql } from 'drizzle-orm';
import { db, shows, flowsheet, cronjob_runs, closeDatabaseConnection } from '@wxyc/database';
import { parseInsertLine } from './parse-dump.js';
import { mapProdEntryType, epochMsToDate, resolveEntryTimestamp, parseShowEntryDJName, truncate } from './transform.js';
import { fetchLegacyShows, fetchLegacyEntries, closeLegacyConnection } from './fetch-legacy.js';

const JOB_NAME = 'flowsheet-etl';
const BATCH_SIZE = 5000;

const getLastRunTimestamp = async (): Promise<number | null> => {
  const response = await db
    .select({ lastRun: cronjob_runs.last_run })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, JOB_NAME))
    .limit(1);
  const lastRun = response[0]?.lastRun ?? null;
  return lastRun ? lastRun.getTime() : null;
};

const updateLastRun = async (timestamp: Date) => {
  await db
    .insert(cronjob_runs)
    .values({ job_name: JOB_NAME, last_run: timestamp })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: timestamp },
    });
};

/**
 * Reset PostgreSQL sequences after a bulk load so that new inserts
 * get IDs greater than the imported data.
 */
const resetSequences = async () => {
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('wxyc_schema.shows', 'id'), COALESCE((SELECT MAX(id) FROM wxyc_schema.shows), 0) + 1, false)`
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('wxyc_schema.flowsheet', 'id'), COALESCE((SELECT MAX(id) FROM wxyc_schema.flowsheet), 0) + 1, false)`
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('wxyc_schema.flowsheet', 'play_order'), COALESCE((SELECT MAX(play_order) FROM wxyc_schema.flowsheet), 0) + 1, false)`
  );
  console.log('[flowsheet-etl] Reset sequences to max(id)+1.');
};

/**
 * Resolve the artist_name for a flowsheet entry. For show_start/show_end entries,
 * parse the DJ name from the structured ARTIST_NAME text. For all other entries,
 * truncate to 128 chars.
 */
const resolveArtistName = (rawArtistName: string | null, entryType: string): string | null => {
  if (!rawArtistName) return null;
  if (entryType === 'show_start' || entryType === 'show_end') {
    return truncate(parseShowEntryDJName(rawArtistName), 128) ?? truncate(rawArtistName, 128);
  }
  return truncate(rawArtistName, 128);
};

// ---- Bulk Load Mode ----

/**
 * FLOWSHEET_RADIO_SHOW_PROD columns (by position in dump tuple):
 *   0: ID, 1: STARTING_RADIO_HOUR, 2: DJ_NAME, 3: DJ_ID, 4: DJ_HANDLE,
 *   5: SHOW_NAME, 6: SPECIALTY_SHOW_ID, 7: WORKING_HOUR, 8: SIGNON_TIME,
 *   9: SIGNOFF_TIME, 10: TIME_LAST_MODIFIED, 11: TIME_CREATED, 12: MODLOCK, 13: SHOW_ID
 *
 * FLOWSHEET_ENTRY_PROD columns (by position in dump tuple):
 *   0: ID, 1: ARTIST_NAME, 2: ARTIST_ID, 3: SONG_TITLE, 4: RELEASE_TITLE,
 *   5: RELEASE_FORMAT_ID, 6: LIBRARY_RELEASE_ID, 7: ROTATION_RELEASE_ID,
 *   8: LABEL_NAME, 9: RADIO_HOUR, 10: START_TIME, 11: STOP_TIME,
 *   12: RADIO_SHOW_ID, 13: SEQUENCE_WITHIN_SHOW, 14: NOW_PLAYING_FLAG,
 *   15: FLOWSHEET_ENTRY_TYPE_CODE_ID, 16: TIME_LAST_MODIFIED, 17: TIME_CREATED,
 *   18: REQUEST_FLAG, 19: GLOBAL_ORDER_ID, 20: BMI_COMPOSER
 *   [21: SEGUE_FLAG -- if present]
 */

const runBulkLoad = async (dumpPath: string) => {
  console.log(`[flowsheet-etl] Bulk load from: ${dumpPath}`);
  const content = readFileSync(dumpPath, 'utf-8');
  const lines = content.split('\n');

  let showCount = 0;
  let entryCount = 0;
  const pendingEntries: Array<{
    legacy_entry_id: number;
    show_id: number | null;
    entry_type: 'track' | 'show_start' | 'show_end' | 'breakpoint' | 'talkset' | 'dj_join' | 'dj_leave' | 'message';
    artist_name: string | null;
    album_title: string | null;
    track_title: string | null;
    record_label: string | null;
    message: string | null;
    request_flag: boolean;
    segue: boolean;
    play_order: number;
    add_time: Date;
  }> = [];

  // Pass 1: Import shows
  console.log('[flowsheet-etl] Pass 1: Importing shows...');
  for (const line of lines) {
    const parsed = parseInsertLine(line);
    if (!parsed || parsed.table !== 'FLOWSHEET_RADIO_SHOW_PROD') continue;

    for (const tuple of parsed.tuples) {
      const startTime = epochMsToDate(Number(tuple[8]) || 0);
      if (!startTime) continue;

      await db
        .insert(shows)
        .values({
          legacy_show_id: Number(tuple[0]),
          start_time: startTime,
          end_time: epochMsToDate(Number(tuple[9]) || 0),
          show_name: truncate(String(tuple[5] ?? ''), 128),
        })
        .onConflictDoNothing();
      showCount++;
    }
  }
  console.log(`[flowsheet-etl] Imported ${showCount} shows.`);

  // Build show mapping: legacy_show_id -> backend show id
  const showRows = await db.select({ id: shows.id, legacyId: shows.legacy_show_id }).from(shows);
  const showIdMap = new Map<number, number>();
  for (const row of showRows) {
    if (row.legacyId != null) {
      showIdMap.set(row.legacyId, row.id);
    }
  }

  // Pass 2: Import entries
  console.log('[flowsheet-etl] Pass 2: Importing entries...');
  for (const line of lines) {
    const parsed = parseInsertLine(line);
    if (!parsed || parsed.table !== 'FLOWSHEET_ENTRY_PROD') continue;

    for (const tuple of parsed.tuples) {
      const addTime = resolveEntryTimestamp(
        Number(tuple[10]) || 0, // START_TIME
        Number(tuple[17]) || 0, // TIME_CREATED
        Number(tuple[16]) || 0 // TIME_LAST_MODIFIED
      );
      if (!addTime) continue;
      const entryId = Number(tuple[0]);
      const showId = Number(tuple[12]);
      if (!Number.isFinite(entryId) || !Number.isFinite(showId)) continue;

      const entryType = mapProdEntryType(Number(tuple[15]) || 0);
      const backendShowId = showIdMap.get(showId);
      const rawArtistName = tuple[1] != null ? String(tuple[1]) : null;

      pendingEntries.push({
        legacy_entry_id: entryId,
        show_id: backendShowId ?? null,
        entry_type: entryType,
        artist_name: resolveArtistName(rawArtistName, entryType),
        album_title: truncate(tuple[4] != null ? String(tuple[4]) : null, 128),
        track_title: truncate(tuple[3] != null ? String(tuple[3]) : null, 128),
        record_label: truncate(tuple[8] != null ? String(tuple[8]) : null, 128),
        message: null,
        request_flag: Number(tuple[18]) === 1,
        segue: tuple.length > 21 ? Number(tuple[21]) === 1 : false,
        play_order: Number(tuple[13]) || 0,
        add_time: addTime,
      });

      if (pendingEntries.length >= BATCH_SIZE) {
        await db.insert(flowsheet).values(pendingEntries).onConflictDoNothing();
        entryCount += pendingEntries.length;
        pendingEntries.length = 0;
        if (entryCount % 50000 === 0) {
          console.log(`[flowsheet-etl] ...${entryCount} entries processed.`);
        }
      }
    }
  }

  // Flush remaining entries
  if (pendingEntries.length > 0) {
    await db.insert(flowsheet).values(pendingEntries).onConflictDoNothing();
    entryCount += pendingEntries.length;
  }

  console.log(`[flowsheet-etl] Imported ${entryCount} entries.`);
  await resetSequences();
};

// ---- Incremental Sync Mode ----

const runIncremental = async () => {
  const runStartedAt = new Date();
  const lastRunMs = await getLastRunTimestamp();

  // Sync shows
  const legacyShows = await fetchLegacyShows(lastRunMs);
  let showsImported = 0;
  for (const show of legacyShows) {
    const startTime = epochMsToDate(show.startTime);
    const endTime = epochMsToDate(show.endTime);
    if (!startTime) continue;

    await db
      .insert(shows)
      .values({
        legacy_show_id: show.id,
        start_time: startTime,
        end_time: endTime,
        show_name: truncate(show.showName, 128),
      })
      .onConflictDoNothing();
    showsImported++;
  }

  // Build show mapping
  const showRows = await db.select({ id: shows.id, legacyId: shows.legacy_show_id }).from(shows);
  const showIdMap = new Map<number, number>();
  for (const row of showRows) {
    if (row.legacyId != null) {
      showIdMap.set(row.legacyId, row.id);
    }
  }

  // Sync entries
  const legacyEntries = await fetchLegacyEntries(lastRunMs);
  let entriesImported = 0;
  for (const entry of legacyEntries) {
    const addTime = epochMsToDate(entry.startTime);
    if (!addTime) continue;

    const backendShowId = showIdMap.get(entry.showId);
    const entryType = mapProdEntryType(entry.entryTypeCode);

    await db
      .insert(flowsheet)
      .values({
        legacy_entry_id: entry.id,
        show_id: backendShowId ?? null,
        entry_type: entryType,
        artist_name: resolveArtistName(entry.artistName, entryType),
        album_title: truncate(entry.albumTitle, 128),
        track_title: truncate(entry.trackTitle, 128),
        record_label: truncate(entry.label, 128),
        message: null,
        request_flag: entry.requestFlag === 1,
        segue: entry.segueFlag === 1,
        play_order: entry.playOrder,
        add_time: addTime,
      })
      .onConflictDoNothing();
    entriesImported++;
  }

  await updateLastRun(runStartedAt);
  console.log(`[flowsheet-etl] Incremental sync: ${showsImported} shows, ${entriesImported} entries.`);
};

// ---- Main ----

const run = async () => {
  try {
    const dumpPath = process.argv[2];
    if (dumpPath && !dumpPath.startsWith('--')) {
      await runBulkLoad(dumpPath);
    } else {
      await runIncremental();
    }
  } finally {
    await closeDatabaseConnection();
    closeLegacyConnection();
  }
};

run().catch((error) => {
  console.error('[flowsheet-etl] Failed:', error);
  process.exitCode = 1;
});
