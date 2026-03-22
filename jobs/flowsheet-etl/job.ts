/**
 * Flowsheet ETL: Import and sync flowsheet data from tubafrenzy.
 *
 * Two modes:
 * - Bulk load: node --max-old-space-size=4096 dist/job.js /path/to/dump.sql [--force]
 * - Incremental sync: node dist/job.js (no arguments, used by cron)
 */

import { eq, sql } from 'drizzle-orm';
import { db, flowsheet, shows, library, cronjob_runs, closeDatabaseConnection, NewFSEntry } from '@wxyc/database';
import { parseDumpShows, parseDumpEntries } from './parse-dump.js';
import { fetchLegacyShows, fetchLegacyEntries, closeLegacyConnection } from './fetch-legacy.js';
import { transformShow, transformEntry } from './transform.js';

const JOB_NAME = 'flowsheet-etl';

// ── Shared helpers ──────────────────────────────────────────────────────────

async function getLastRunTimestamp(): Promise<number | null> {
  const response = await db
    .select({ lastRun: cronjob_runs.last_run })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, JOB_NAME))
    .limit(1);

  const lastRun = response[0]?.lastRun ?? null;
  return lastRun ? lastRun.getTime() : null;
}

async function updateLastRun(timestamp: Date) {
  await db
    .insert(cronjob_runs)
    .values({ job_name: JOB_NAME, last_run: timestamp })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: timestamp },
    });
}

async function buildLegacyReleaseMap(): Promise<Map<number, number>> {
  const rows = await db
    .select({ id: library.id, legacy_release_id: library.legacy_release_id })
    .from(library)
    .where(sql`${library.legacy_release_id} IS NOT NULL`);

  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.legacy_release_id != null) {
      map.set(row.legacy_release_id, row.id);
    }
  }

  console.log(`[flowsheet-etl] Loaded ${map.size} legacy release ID mappings from library.`);
  return map;
}

// ── Bulk load mode ──────────────────────────────────────────────────────────

async function bulkLoad(dumpFilePath: string, force: boolean) {
  console.log(`[flowsheet-etl] Bulk load mode: ${dumpFilePath}`);

  // Safety check: tables should be empty unless --force
  const showCount = await db.select({ count: sql<number>`count(*)::int` }).from(shows);
  const entryCount = await db.select({ count: sql<number>`count(*)::int` }).from(flowsheet);
  const existingShows = showCount[0].count;
  const existingEntries = entryCount[0].count;

  if (existingShows > 0 || existingEntries > 0) {
    if (!force) {
      console.error(
        `[flowsheet-etl] Tables not empty (${existingShows} shows, ${existingEntries} entries). Use --force to truncate.`
      );
      process.exitCode = 1;
      return;
    }
    console.warn('[flowsheet-etl] --force: truncating shows and flowsheet tables...');
    await db.execute(sql`TRUNCATE TABLE ${flowsheet} CASCADE`);
    await db.execute(sql`TRUNCATE TABLE ${shows} CASCADE`);
  }

  // Pass 1: Parse shows
  console.log('[flowsheet-etl] Pass 1: Parsing shows from dump...');
  const rawShows = await parseDumpShows(dumpFilePath);
  console.log(`[flowsheet-etl] Parsed ${rawShows.length} shows.`);

  // Build legacy release map for album_id resolution
  const legacyReleaseMap = await buildLegacyReleaseMap();

  // Insert shows, sorted by ID ascending, in batches of 1000
  rawShows.sort((a, b) => a.id - b.id);
  let showsInserted = 0;
  for (let i = 0; i < rawShows.length; i += 1000) {
    const batch = rawShows.slice(i, i + 1000);
    const transformed = batch.map(transformShow);
    await db.insert(shows).values(
      transformed.map((s) => ({
        id: s.legacy_show_id, // preserve legacy IDs as both id and legacy_show_id
        legacy_show_id: s.legacy_show_id,
        start_time: s.start_time,
        end_time: s.end_time,
        show_name: s.show_name,
        primary_dj_id: s.primary_dj_id,
        specialty_id: s.specialty_id,
      }))
    );
    showsInserted += batch.length;
  }
  console.log(`[flowsheet-etl] Inserted ${showsInserted} shows.`);

  // Pass 2: Stream entries from dump
  console.log('[flowsheet-etl] Pass 2: Streaming entries from dump...');
  let entriesInserted = 0;
  let unmatchedLibraryIds = 0;

  for await (const batch of parseDumpEntries(dumpFilePath)) {
    const insertValues = batch.map((raw) => {
      const entry = transformEntry(raw, legacyReleaseMap);
      if (raw.library_release_id > 0 && entry.album_id == null) {
        unmatchedLibraryIds++;
      }
      return {
        show_id: raw.radio_show_id > 0 ? raw.radio_show_id : null,
        album_id: entry.album_id,
        rotation_id: entry.rotation_id,
        legacy_entry_id: entry.legacy_entry_id,
        entry_type: entry.entry_type as NewFSEntry['entry_type'],
        track_title: entry.track_title,
        album_title: entry.album_title,
        artist_name: entry.artist_name,
        record_label: entry.record_label,
        label_id: entry.label_id,
        request_flag: entry.request_flag,
        message: entry.message,
        add_time: entry.add_time,
      };
    });

    if (insertValues.length > 0) {
      await db.insert(flowsheet).values(insertValues);
    }

    entriesInserted += batch.length;
    if (entriesInserted % 100_000 === 0) {
      console.log(`[flowsheet-etl] Progress: ${entriesInserted} entries inserted...`);
    }
  }

  console.log(`[flowsheet-etl] Inserted ${entriesInserted} entries.`);

  // Reset PostgreSQL sequences
  console.log('[flowsheet-etl] Resetting sequences...');
  const schemaName = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  await db.execute(
    sql.raw(
      `SELECT setval(pg_get_serial_sequence('${schemaName}.shows', 'id'), COALESCE((SELECT MAX(id) FROM ${schemaName}.shows), 1))`
    )
  );
  await db.execute(
    sql.raw(
      `SELECT setval(pg_get_serial_sequence('${schemaName}.flowsheet', 'id'), COALESCE((SELECT MAX(id) FROM ${schemaName}.flowsheet), 1))`
    )
  );
  await db.execute(
    sql.raw(
      `SELECT setval(pg_get_serial_sequence('${schemaName}.flowsheet', 'play_order'), COALESCE((SELECT MAX(play_order) FROM ${schemaName}.flowsheet), 1))`
    )
  );

  // Update cronjob tracking
  await updateLastRun(new Date());

  console.log('[flowsheet-etl] Bulk load complete.');
  console.log(`  Shows inserted:       ${showsInserted}`);
  console.log(`  Entries inserted:     ${entriesInserted}`);
  console.log(`  Unmatched library IDs: ${unmatchedLibraryIds}`);
}

// ── Incremental sync mode ───────────────────────────────────────────────────

async function incrementalSync() {
  console.log('[flowsheet-etl] Incremental sync mode.');

  const lastRunMs = await getLastRunTimestamp();
  if (lastRunMs == null) {
    console.error('[flowsheet-etl] No previous run found. Run bulk load first.');
    process.exitCode = 1;
    return;
  }

  const runStartedAt = new Date();
  console.log(`[flowsheet-etl] Last run: ${new Date(lastRunMs).toISOString()}`);

  // Build maps
  const legacyReleaseMap = await buildLegacyReleaseMap();

  // Build show ID map: legacy_show_id -> backend shows.id
  const existingShows = await db
    .select({ id: shows.id, legacy_show_id: shows.legacy_show_id })
    .from(shows)
    .where(sql`${shows.legacy_show_id} IS NOT NULL`);
  const showIdMap = new Map<number, number>();
  for (const row of existingShows) {
    if (row.legacy_show_id != null) {
      showIdMap.set(row.legacy_show_id, row.id);
    }
  }

  // Build set of existing legacy_entry_ids for deduplication
  const existingEntries = await db
    .select({ legacy_entry_id: flowsheet.legacy_entry_id })
    .from(flowsheet)
    .where(sql`${flowsheet.legacy_entry_id} IS NOT NULL`);
  const existingEntryIds = new Set(existingEntries.map((e) => e.legacy_entry_id));

  // Fetch and import new shows
  const newShows = await fetchLegacyShows(lastRunMs);
  let showsInserted = 0;
  let showsSkipped = 0;

  for (const rawShow of newShows) {
    if (showIdMap.has(rawShow.id)) {
      showsSkipped++;
      continue;
    }

    const transformed = transformShow(rawShow);
    const inserted = await db
      .insert(shows)
      .values({
        legacy_show_id: transformed.legacy_show_id,
        start_time: transformed.start_time,
        end_time: transformed.end_time,
        show_name: transformed.show_name,
        primary_dj_id: transformed.primary_dj_id,
        specialty_id: transformed.specialty_id,
      })
      .returning({ id: shows.id });

    if (inserted[0]) {
      showIdMap.set(rawShow.id, inserted[0].id);
    }
    showsInserted++;
  }

  // Fetch and import new entries
  const newEntries = await fetchLegacyEntries(lastRunMs);
  let entriesInserted = 0;
  let entriesSkipped = 0;

  const BATCH_SIZE = 1000;
  let batch: NewFSEntry[] = [];

  for (const rawEntry of newEntries) {
    if (existingEntryIds.has(rawEntry.id)) {
      entriesSkipped++;
      continue;
    }

    const transformed = transformEntry(rawEntry, legacyReleaseMap);
    const backendShowId = rawEntry.radio_show_id > 0 ? (showIdMap.get(rawEntry.radio_show_id) ?? null) : null;

    batch.push({
      show_id: backendShowId,
      album_id: transformed.album_id,
      rotation_id: transformed.rotation_id,
      legacy_entry_id: transformed.legacy_entry_id,
      entry_type: transformed.entry_type as NewFSEntry['entry_type'],
      track_title: transformed.track_title,
      album_title: transformed.album_title,
      artist_name: transformed.artist_name,
      record_label: transformed.record_label,
      label_id: transformed.label_id,
      request_flag: transformed.request_flag,
      message: transformed.message,
      add_time: transformed.add_time,
    });

    if (batch.length >= BATCH_SIZE) {
      await db.insert(flowsheet).values(batch);
      entriesInserted += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await db.insert(flowsheet).values(batch);
    entriesInserted += batch.length;
  }

  await updateLastRun(runStartedAt);

  console.log('[flowsheet-etl] Incremental sync complete.');
  console.log(`  Shows:   ${showsInserted} inserted, ${showsSkipped} skipped`);
  console.log(`  Entries: ${entriesInserted} inserted, ${entriesSkipped} skipped`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  try {
    const args = process.argv.slice(2);
    const dumpFilePath = args.find((a) => !a.startsWith('--'));
    const force = args.includes('--force');

    if (dumpFilePath) {
      await bulkLoad(dumpFilePath, force);
    } else {
      await incrementalSync();
    }
  } finally {
    await closeDatabaseConnection();
    try {
      closeLegacyConnection();
    } catch {
      // Legacy connection may not be open in bulk mode
    }
  }
}

run().catch((error) => {
  console.error('[flowsheet-etl] Failed:', error);
  process.exitCode = 1;
});
