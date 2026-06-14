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

type SyncResult = { imported: number; matched: number };

const runIncremental = async (): Promise<SyncResult> => {
  const runStartedAt = new Date();
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);

  const legacyReleases = await fetchLegacyRotation(lastRunMs);

  let imported = 0;
  // Rows whose legacy_rotation_id already existed in PG. Not necessarily
  // updated — setWhere skips the UPDATE when every excluded.* value matches.
  let matched = 0;

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
          // BS#1029: tubafrenzy paste wins when it contributes a non-NULL
          // id; otherwise preserve any value written by
          // jobs/rotation-release-id-backfill. Without COALESCE, an
          // excluded NULL would clobber the backfill's writes on every
          // 30-min tick (the load-bearing regression BS#1029 closes).
          discogs_release_id: sql`COALESCE(excluded.discogs_release_id, ${rotation.discogs_release_id})`,
          // Provenance mirrors COALESCE above: when tubafrenzy contributes
          // a non-NULL id the source flips to 'tubafrenzy_paste' (the
          // MD-verified-via-paste-URL invariant), otherwise the persisted
          // source stays. Without this, a later tubafrenzy paste over a
          // backfill-written row would leave provenance reading
          // 'lml_offline_backfill' even though the value is now MD-verified.
          discogs_release_id_source: sql`
            CASE WHEN excluded.discogs_release_id IS NOT NULL
                 THEN 'tubafrenzy_paste'::wxyc_schema.discogs_release_id_source_enum
                 ELSE ${rotation.discogs_release_id_source}
            END
          `,
          // BS#1380: drift prevention. lml_identity_id was minted against
          // the persisted discogs_release_id (either by addToRotation at
          // INSERT time or by jobs/rotation-lml-identity-backfill); if a
          // tubafrenzy paste-correction changes the discogs_release_id,
          // the persisted lml_identity_id no longer matches the new id and
          // the row must be cleared so the backfill cron re-resolves it.
          //
          // The "effective" qualifier matters: the discogs_release_id SET
          // above uses COALESCE(excluded, persisted), so when tubafrenzy
          // contributes NULL (the common case for rows without a paste
          // URL) the discogs_release_id doesn't change. A CASE that fired
          // on raw `excluded IS DISTINCT FROM rotation` would also fire
          // on every tick where excluded is NULL and persisted is
          // non-NULL — three-valued SQL has `NULL IS DISTINCT FROM X` =
          // TRUE — silently nulling a perfectly-good lml_identity_id on
          // every kill_date / artist_name / etc. change.
          //
          // Guard symmetric to the existing setWhere term at lines
          // 153-154 (`excluded.discogs_release_id IS NOT NULL AND IS
          // DISTINCT FROM rotation.discogs_release_id`): only clear
          // when tubafrenzy supplied a non-NULL different id.
          //
          // Equivalent formulation:
          //   COALESCE(excluded.discogs_release_id, rotation.discogs_release_id)
          //     IS DISTINCT FROM rotation.discogs_release_id
          //
          // setWhere is unchanged — the existing discogs_release_id term
          // already fires the gate on the Y_X → NULL transition. Adding
          // an `excluded.lml_identity_id IS DISTINCT FROM rotation
          // .lml_identity_id` term would *break* the gate: since
          // lml_identity_id isn't in the INSERT VALUES tuple,
          // excluded.lml_identity_id is always NULL, so the term would be
          // TRUE on every tick for any row with a populated identity —
          // turning the gate into a no-op for the rows BS#1059's
          // xmin/CDC discipline most cares about.
          lml_identity_id: sql`
            CASE WHEN excluded.discogs_release_id IS NOT NULL
                  AND excluded.discogs_release_id IS DISTINCT FROM ${rotation.discogs_release_id}
                 THEN NULL
                 ELSE ${rotation.lml_identity_id}
            END
          `,
        },
        // BS#1059 mechanic; the 30-min cron was rewriting most rows every cycle.
        // BS#1029: the plain IS DISTINCT FROM term on discogs_release_id
        // would fire harmlessly when excluded was NULL but rotation held a
        // backfill-written value — COALESCE turns the write into a no-op
        // value-wise, but the row's xmin still bumps and CDC fires. Gate
        // the term on "excluded is non-NULL" so a NULL upstream value cannot
        // trigger a redundant UPDATE on a backfilled row.
        setWhere: sql`
          ${rotation.album_id} IS DISTINCT FROM excluded.album_id OR
          ${rotation.legacy_library_release_id} IS DISTINCT FROM excluded.legacy_library_release_id OR
          ${rotation.rotation_bin} IS DISTINCT FROM excluded.rotation_bin OR
          ${rotation.kill_date} IS DISTINCT FROM excluded.kill_date OR
          ${rotation.artist_name} IS DISTINCT FROM excluded.artist_name OR
          ${rotation.album_title} IS DISTINCT FROM excluded.album_title OR
          ${rotation.record_label} IS DISTINCT FROM excluded.record_label OR
          (excluded.discogs_release_id IS NOT NULL
            AND ${rotation.discogs_release_id} IS DISTINCT FROM excluded.discogs_release_id)
        `,
      });

    if (existing) {
      matched++;
    } else {
      imported++;
    }
  }

  // Resolve any previously-unresolvable album IDs (library ETL may have run since)
  await resolveAlbumIds();

  await updateLastRun(JOB_NAME, runStartedAt);
  const parts = [`${imported} new releases`];
  if (matched > 0) parts.push(`${matched} matched releases`);
  console.log(`[rotation-etl] Incremental sync: ${parts.join(', ')}.`);

  return { imported, matched };
};

// ---- Main ----

const run = async () => {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--poll')) {
      await runPollingLoop(
        async () => {
          const result = await runIncremental();
          return { hasChanges: result.imported > 0 || result.matched > 0 };
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
