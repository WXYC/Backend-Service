/**
 * Writer for jobs/rotation-release-id-backfill (BS#1029).
 *
 * Idempotent single-row UPDATE that persists an LML-resolved Discogs release
 * id on a rotation row. The WHERE clause guards on `discogs_release_id IS
 * NULL` so a rerun is safe and a mid-run tubafrenzy paste cannot be
 * clobbered — that case manifests as a 0-row UPDATE which the orchestrator
 * reads via `written: false` and rolls into its `raced` counter.
 *
 * Source is always written as `lml_offline_backfill`; the rotation-etl
 * ON CONFLICT CASE-flip (see jobs/rotation-etl/job.ts) handles the
 * reverse direction when a later tubafrenzy paste arrives.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, rotation } from '@wxyc/database';

export const writeReleaseId = async (rotationId: number, releaseId: number): Promise<{ written: boolean }> => {
  const updated = await db
    .update(rotation)
    .set({
      discogs_release_id: releaseId,
      discogs_release_id_source: 'lml_offline_backfill',
    })
    .where(and(eq(rotation.id, rotationId), isNull(rotation.discogs_release_id)))
    .returning({ id: rotation.id });
  return { written: updated.length === 1 };
};
