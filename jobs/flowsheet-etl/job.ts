/**
 * Flowsheet ETL: Import and sync flowsheet data from tubafrenzy.
 *
 * Two modes:
 * - Bulk load: Parse a mysqldump file and insert shows + entries in batches
 * - Incremental: Query tubafrenzy via MirrorSQL for new data since last run
 *
 * Usage:
 *   node dist/job.js /path/to/dump.sql [--force]   # bulk load
 *   node dist/job.js                                # incremental sync
 */

import { readFileSync } from 'fs';
import { eq, sql } from 'drizzle-orm';
import { db, shows, flowsheet, cronjob_runs, closeDatabaseConnection } from '@wxyc/database';
import { parseInsertLine } from './parse-dump.js';
import { transformShow, transformEntry, mapEntryType, truncate, parseMySQLDatetime } from './transform.js';
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

// ---- Bulk Load Mode ----

const runBulkLoad = async (dumpPath: string) => {
  console.log(`[flowsheet-etl] Bulk load from: ${dumpPath}`);
  const content = readFileSync(dumpPath, 'utf-8');
  const lines = content.split('\n');

  let showCount = 0;
  let entryCount = 0;
  const pendingEntries: Array<{
    legacy_entry_id: number;
    show_id: number | null;
    entry_type: string;
    artist_name: string | null;
    album_title: string | null;
    track_title: string | null;
    record_label: string | null;
    message: string | null;
    request_flag: boolean;
    play_order: number;
    add_time: Date;
  }> = [];

  // Pass 1: Import shows
  console.log('[flowsheet-etl] Pass 1: Importing shows...');
  for (const line of lines) {
    const parsed = parseInsertLine(line);
    if (!parsed || parsed.table !== 'PLAYLIST_SHOW') continue;

    for (const tuple of parsed.tuples) {
      const show = transformShow(tuple as [number, string, string | null]);
      if (!show) continue;

      await db
        .insert(shows)
        .values({
          legacy_show_id: show.legacy_show_id,
          start_time: show.start_time,
          end_time: show.end_time,
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
    if (!parsed || parsed.table !== 'PLAYLIST_ENTRY') continue;

    for (const tuple of parsed.tuples) {
      const entry = transformEntry(tuple);
      if (!entry) continue;

      const backendShowId = showIdMap.get(entry.legacy_show_id);

      pendingEntries.push({
        legacy_entry_id: entry.legacy_entry_id,
        show_id: backendShowId ?? null,
        entry_type: entry.entry_type,
        artist_name: entry.artist_name,
        album_title: entry.album_title,
        track_title: entry.track_title,
        record_label: entry.record_label,
        message: entry.message,
        request_flag: entry.request_flag,
        play_order: entry.play_order,
        add_time: entry.add_time,
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
    const startTime = parseMySQLDatetime(show.startTime);
    const endTime = show.endTime ? parseMySQLDatetime(show.endTime) : null;
    if (!startTime) continue;

    await db
      .insert(shows)
      .values({
        legacy_show_id: show.id,
        start_time: startTime,
        end_time: endTime,
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
    const addTime = parseMySQLDatetime(entry.timePlayed);
    if (!addTime) continue;

    const backendShowId = showIdMap.get(entry.showId);

    await db
      .insert(flowsheet)
      .values({
        legacy_entry_id: entry.id,
        show_id: backendShowId ?? null,
        entry_type: mapEntryType(entry.entryType),
        artist_name: truncate(entry.artistName, 128),
        album_title: truncate(entry.albumTitle, 128),
        track_title: truncate(entry.trackTitle, 128),
        record_label: truncate(entry.label, 128),
        message: truncate(entry.message, 250),
        request_flag: entry.requestFlag === 1,
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
