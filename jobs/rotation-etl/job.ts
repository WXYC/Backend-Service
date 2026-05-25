/**
 * Rotation ETL: Import and sync rotation data from tubafrenzy.
 *
 * Two modes:
 * - Incremental: Query tubafrenzy via MirrorSQL for new data since last run
 * - Polling: Continuous incremental sync at a configurable interval
 *
 * Source table: ROTATION_RELEASE (joined with COMPANY for label names)
 *
 * Usage:
 *   node dist/job.js          # one-shot incremental sync
 *   node dist/job.js --poll   # continuous polling loop
 */

import { eq, sql } from 'drizzle-orm';
import {
  db,
  rotation,
  library,
  closeDatabaseConnection,
  getLastRunTimestamp,
  updateLastRun,
  runPollingLoop,
  truncate,
} from '@wxyc/database';
import { mapRotationType, epochMsToDateString } from './transform.js';
import { fetchLegacyRotation, closeLegacyConnection } from './fetch-legacy.js';

const JOB_NAME = 'rotation-etl';

/**
 * Resolve rotation.album_id by joining legacy_library_release_id to library.legacy_release_id.
 * Only updates entries where album_id is NULL and legacy_library_release_id is set.
 * Clears denormalized display fields once album_id is resolved.
 */
const resolveAlbumIds = async (): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE ${rotation} r
    SET album_id = l.id,
        artist_name = NULL,
        album_title = NULL,
        record_label = NULL
    FROM ${library} l
    WHERE r.legacy_library_release_id = l.legacy_release_id
      AND r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `);
  const count = Number(result.count ?? 0);
  if (count > 0) {
    console.log(`[rotation-etl] Resolved album_id for ${count} rotation entries.`);
  }
  return count;
};

// ---- Incremental Sync Mode ----

type SyncResult = { imported: number; updated: number };

const runIncremental = async (): Promise<SyncResult> => {
  const runStartedAt = new Date();
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);

  const legacyReleases = await fetchLegacyRotation(lastRunMs);

  let imported = 0;
  let updated = 0;

  for (const release of legacyReleases) {
    if (!Number.isFinite(release.id)) continue;

    const rotationBin = mapRotationType(release.rotationType);
    const addDate = epochMsToDateString(release.addDate) ?? new Date().toISOString().split('T')[0];
    const killDate = epochMsToDateString(release.killDate);

    // Resolve album_id inline for this release
    let albumId: number | null = null;
    if (release.libraryReleaseId) {
      const [row] = await db
        .select({ id: library.id })
        .from(library)
        .where(eq(library.legacy_release_id, release.libraryReleaseId))
        .limit(1);
      albumId = row?.id ?? null;
    }

    // Check if this is an insert or update
    const [existing] = await db
      .select({ id: rotation.id })
      .from(rotation)
      .where(eq(rotation.legacy_rotation_id, release.id))
      .limit(1);

    await db
      .insert(rotation)
      .values({
        legacy_rotation_id: release.id,
        legacy_library_release_id: release.libraryReleaseId,
        album_id: albumId,
        rotation_bin: rotationBin,
        add_date: addDate,
        kill_date: killDate,
        artist_name: albumId ? null : truncate(release.artistName, 128),
        album_title: albumId ? null : truncate(release.albumTitle, 128),
        record_label: albumId ? null : truncate(release.labelName, 128),
        discogs_release_id: release.discogsReleaseId,
      })
      .onConflictDoUpdate({
        target: rotation.legacy_rotation_id,
        set: {
          album_id: sql`excluded.album_id`,
          legacy_library_release_id: sql`excluded.legacy_library_release_id`,
          rotation_bin: sql`excluded.rotation_bin`,
          kill_date: sql`excluded.kill_date`,
          artist_name: sql`excluded.artist_name`,
          album_title: sql`excluded.album_title`,
          record_label: sql`excluded.record_label`,
          discogs_release_id: sql`excluded.discogs_release_id`,
        },
        // BS#1059 mechanic applied to rotation per BS#1063: skip the UPDATE
        // when every excluded.* value already matches. The 30-min cron was
        // rewriting most rows every cycle even when nothing changed.
        setWhere: sql`
          ${rotation.album_id} IS DISTINCT FROM excluded.album_id OR
          ${rotation.legacy_library_release_id} IS DISTINCT FROM excluded.legacy_library_release_id OR
          ${rotation.rotation_bin} IS DISTINCT FROM excluded.rotation_bin OR
          ${rotation.kill_date} IS DISTINCT FROM excluded.kill_date OR
          ${rotation.artist_name} IS DISTINCT FROM excluded.artist_name OR
          ${rotation.album_title} IS DISTINCT FROM excluded.album_title OR
          ${rotation.record_label} IS DISTINCT FROM excluded.record_label OR
          ${rotation.discogs_release_id} IS DISTINCT FROM excluded.discogs_release_id
        `,
      });

    if (existing) {
      updated++;
    } else {
      imported++;
    }
  }

  // Resolve any previously-unresolvable album IDs (library ETL may have run since)
  await resolveAlbumIds();

  await updateLastRun(JOB_NAME, runStartedAt);
  const parts = [`${imported} new releases`];
  if (updated > 0) parts.push(`${updated} updated releases`);
  console.log(`[rotation-etl] Incremental sync: ${parts.join(', ')}.`);

  return { imported, updated };
};

// ---- Main ----

const run = async () => {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--poll')) {
      await runPollingLoop(
        async () => {
          const result = await runIncremental();
          return { hasChanges: result.imported > 0 || result.updated > 0 };
        },
        { jobName: JOB_NAME, notifyPath: '/internal/rotation-sync-notify' }
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
  console.error('[rotation-etl] Failed:', error);
  process.exitCode = 1;
});
