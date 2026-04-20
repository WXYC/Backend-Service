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
 *   node dist/job.js /path/to/dump.sql              # bulk load (append to existing)
 *   node dist/job.js /path/to/dump.sql --replace    # truncate + bulk load in one transaction
 *   node dist/job.js                                # one-shot incremental sync
 *   node dist/job.js --poll                         # continuous polling loop
 */

import { readFileSync } from 'fs';
import { inArray, sql } from 'drizzle-orm';
import {
  db,
  shows,
  flowsheet,
  library,
  closeDatabaseConnection,
  getLastRunTimestamp,
  updateLastRun,
  runPollingLoop,
  epochMsToDate,
  truncate,
} from '@wxyc/database';
import { parseInsertLine } from './parse-dump.js';
import { mapProdEntryType, resolveEntryTimestamp, parseShowEntryDJName } from './transform.js';
import { fetchLegacyShows, fetchLegacyEntries, closeLegacyConnection } from './fetch-legacy.js';

const JOB_NAME = 'flowsheet-etl';
const BATCH_SIZE = 5000;

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
 * Resolve flowsheet.album_id by joining legacy_release_id to library.legacy_release_id.
 * Only updates entries where album_id is NULL and legacy_release_id is set.
 * Requires the library ETL to have run first (populates library.legacy_release_id).
 */
const resolveAlbumIds = async () => {
  await db.execute(sql`
    UPDATE ${flowsheet} f
    SET album_id = l.id
    FROM ${library} l
    WHERE f.legacy_release_id = l.legacy_release_id
      AND f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `);
  console.log(`[flowsheet-etl] Resolved album_id for flowsheet entries.`);
};

/** Entry types whose legacy ARTIST_NAME text is display content, not a real artist. */
const isMessageEntryType = (entryType: string): boolean =>
  entryType === 'breakpoint' || entryType === 'talkset' || entryType === 'message';

/**
 * Resolve the artist_name for a flowsheet entry. For show_start/show_end entries,
 * parse the DJ name from the structured ARTIST_NAME text. For message-bearing types
 * (breakpoint, talkset, message), the text belongs in the message field instead.
 */
const resolveArtistName = (rawArtistName: string | null, entryType: string): string | null => {
  if (!rawArtistName) return null;
  if (isMessageEntryType(entryType)) return null;
  if (entryType === 'show_start' || entryType === 'show_end') {
    return truncate(parseShowEntryDJName(rawArtistName), 128) ?? truncate(rawArtistName, 128);
  }
  return truncate(rawArtistName, 128);
};

/**
 * Resolve the message field for a flowsheet entry. For breakpoint, talkset, and
 * message entries, the legacy ARTIST_NAME column contains the display text.
 */
const resolveMessage = (rawArtistName: string | null, entryType: string): string | null => {
  if (!rawArtistName || !isMessageEntryType(entryType)) return null;
  return truncate(rawArtistName, 250);
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

type BulkEntryRow = {
  legacy_entry_id: number;
  legacy_release_id: number | null;
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
};

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const importShows = async (dbClient: DbClient, lines: string[]) => {
  let showCount = 0;
  for (const line of lines) {
    const parsed = parseInsertLine(line);
    if (!parsed || parsed.table !== 'FLOWSHEET_RADIO_SHOW_PROD') continue;

    for (const tuple of parsed.tuples) {
      const startTime = epochMsToDate(Number(tuple[8]) || 0);
      if (!startTime) continue;

      const rawDjId = Number(tuple[3]);
      await dbClient
        .insert(shows)
        .values({
          legacy_show_id: Number(tuple[0]),
          legacy_dj_name: truncate(tuple[2] != null ? String(tuple[2]) : null, 128),
          legacy_dj_id: Number.isFinite(rawDjId) && rawDjId !== 0 ? rawDjId : null,
          start_time: startTime,
          end_time: epochMsToDate(Number(tuple[9]) || 0),
          show_name: truncate(String(tuple[5] ?? ''), 128),
        })
        .onConflictDoNothing();
      showCount++;
    }
  }
  return showCount;
};

const buildShowIdMap = async (dbClient: DbClient) => {
  const showRows = await dbClient.select({ id: shows.id, legacyId: shows.legacy_show_id }).from(shows);
  const map = new Map<number, number>();
  for (const row of showRows) {
    if (row.legacyId != null) {
      map.set(row.legacyId, row.id);
    }
  }
  return map;
};

const importEntries = async (dbClient: DbClient, lines: string[], showIdMap: Map<number, number>) => {
  let entryCount = 0;
  const pendingEntries: BulkEntryRow[] = [];

  for (const line of lines) {
    const parsed = parseInsertLine(line);
    if (!parsed || parsed.table !== 'FLOWSHEET_ENTRY_PROD') continue;

    for (const tuple of parsed.tuples) {
      const addTime = resolveEntryTimestamp(Number(tuple[10]) || 0, Number(tuple[17]) || 0, Number(tuple[16]) || 0);
      if (!addTime) continue;
      const entryId = Number(tuple[0]);
      const showId = Number(tuple[12]);
      if (!Number.isFinite(entryId) || !Number.isFinite(showId)) continue;

      const entryType = mapProdEntryType(Number(tuple[15]) || 0);
      const backendShowId = showIdMap.get(showId);
      const rawArtistName = tuple[1] != null ? String(tuple[1]) : null;
      const rawReleaseId = Number(tuple[6]) || 0;

      pendingEntries.push({
        legacy_entry_id: entryId,
        legacy_release_id: rawReleaseId === 0 ? null : rawReleaseId,
        show_id: backendShowId ?? null,
        entry_type: entryType,
        artist_name: resolveArtistName(rawArtistName, entryType),
        album_title: truncate(tuple[4] != null ? String(tuple[4]) : null, 128),
        track_title: truncate(tuple[3] != null ? String(tuple[3]) : null, 128),
        record_label: truncate(tuple[8] != null ? String(tuple[8]) : null, 128),
        message: resolveMessage(rawArtistName, entryType),
        request_flag: Number(tuple[18]) === 1,
        segue: tuple.length > 21 ? Number(tuple[21]) === 1 : false,
        play_order: Number(tuple[13]) || 0,
        add_time: addTime,
      });

      if (pendingEntries.length >= BATCH_SIZE) {
        await dbClient.insert(flowsheet).values(pendingEntries).onConflictDoNothing();
        entryCount += pendingEntries.length;
        pendingEntries.length = 0;
        if (entryCount % 50000 === 0) {
          console.log(`[flowsheet-etl] ...${entryCount} entries processed.`);
        }
      }
    }
  }

  if (pendingEntries.length > 0) {
    await dbClient.insert(flowsheet).values(pendingEntries).onConflictDoNothing();
    entryCount += pendingEntries.length;
  }

  return entryCount;
};

const runBulkLoad = async (dumpPath: string, { replace = false } = {}) => {
  console.log(`[flowsheet-etl] Bulk load from: ${dumpPath}${replace ? ' (--replace: truncate + reimport)' : ''}`);
  const content = readFileSync(dumpPath, 'utf-8');
  const lines = content.split('\n');

  const doBulkLoad = async (dbClient: DbClient) => {
    if (replace) {
      console.log('[flowsheet-etl] Truncating flowsheet and shows tables...');
      await dbClient.execute(sql`TRUNCATE ${flowsheet}, ${shows} CASCADE`);
    }

    console.log('[flowsheet-etl] Pass 1: Importing shows...');
    const showCount = await importShows(dbClient, lines);
    console.log(`[flowsheet-etl] Imported ${showCount} shows.`);

    const showIdMap = await buildShowIdMap(dbClient);

    console.log('[flowsheet-etl] Pass 2: Importing entries...');
    const entryCount = await importEntries(dbClient, lines, showIdMap);
    console.log(`[flowsheet-etl] Imported ${entryCount} entries.`);
  };

  if (replace) {
    await db.transaction(async (tx) => {
      await doBulkLoad(tx);
    });
  } else {
    await doBulkLoad(db);
  }

  await resetSequences();
  await resolveAlbumIds();
  await updateLastRun(JOB_NAME, new Date());
  console.log('[flowsheet-etl] Recorded last_run for future incremental syncs.');
};

// ---- Incremental Sync Mode ----

type SyncResult = { showsImported: number; entriesImported: number; entriesUpdated: number };

const runIncremental = async (): Promise<SyncResult> => {
  const runStartedAt = new Date();
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);

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
        legacy_dj_name: truncate(show.djName, 128),
        legacy_dj_id: show.djId,
        start_time: startTime,
        end_time: endTime,
        show_name: truncate(show.showName, 128),
      })
      .onConflictDoUpdate({
        target: shows.legacy_show_id,
        set: {
          end_time: sql`excluded.end_time`,
          show_name: sql`excluded.show_name`,
          legacy_dj_name: sql`excluded.legacy_dj_name`,
          legacy_dj_id: sql`excluded.legacy_dj_id`,
        },
      });
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

  // Sync entries (upsert: insert new, update display fields on conflict)
  const legacyEntries = await fetchLegacyEntries(lastRunMs);

  // Collect existing legacy IDs (scoped to this batch) to distinguish inserts from updates
  const batchIds = legacyEntries.map((e) => e.id).filter((id) => Number.isFinite(id));
  const existingIds = new Set(
    batchIds.length > 0
      ? (
          await db
            .select({ lid: flowsheet.legacy_entry_id })
            .from(flowsheet)
            .where(inArray(flowsheet.legacy_entry_id, batchIds))
        ).map((r) => r.lid)
      : []
  );
  let entriesImported = 0;
  let entriesUpdated = 0;
  for (const entry of legacyEntries) {
    const addTime = epochMsToDate(entry.startTime);
    if (!addTime) continue;

    const backendShowId = showIdMap.get(entry.showId);
    const entryType = mapProdEntryType(entry.entryTypeCode);

    await db
      .insert(flowsheet)
      .values({
        legacy_entry_id: entry.id,
        legacy_release_id: entry.legacyReleaseId,
        show_id: backendShowId ?? null,
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
      })
      .onConflictDoUpdate({
        target: flowsheet.legacy_entry_id,
        set: {
          artist_name: sql`excluded.artist_name`,
          album_title: sql`excluded.album_title`,
          track_title: sql`excluded.track_title`,
          record_label: sql`excluded.record_label`,
          message: sql`excluded.message`,
          request_flag: sql`excluded.request_flag`,
          segue: sql`excluded.segue`,
          entry_type: sql`excluded.entry_type`,
        },
      });

    if (existingIds.has(entry.id)) {
      entriesUpdated++;
    } else {
      entriesImported++;
    }
  }

  if (entriesImported > 0) {
    await resolveAlbumIds();
  }

  await updateLastRun(JOB_NAME, runStartedAt);
  const parts = [`${showsImported} shows`, `${entriesImported} new entries`];
  if (entriesUpdated > 0) parts.push(`${entriesUpdated} updated entries`);
  console.log(`[flowsheet-etl] Incremental sync: ${parts.join(', ')}.`);

  return { showsImported, entriesImported, entriesUpdated };
};

// ---- Main ----

const run = async () => {
  try {
    const args = process.argv.slice(2);
    const dumpPath = args.find((a) => !a.startsWith('--'));
    if (dumpPath) {
      await runBulkLoad(dumpPath, { replace: args.includes('--replace') });
    } else if (args.includes('--poll')) {
      await runPollingLoop(
        async () => {
          const result = await runIncremental();
          return { hasChanges: result.entriesImported > 0 || result.entriesUpdated > 0 };
        },
        { jobName: JOB_NAME, notifyPath: '/internal/flowsheet-sync-notify' }
      );
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
