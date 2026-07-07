/**
 * Writer for jobs/rotation-lml-identity-backfill (BS#1380).
 *
 * Idempotent single-row UPDATE that persists an LML-minted identity_id on
 * a rotation row. The WHERE clause guards on `lml_identity_id IS NULL`
 * AND `discogs_release_id = <observed>` so:
 *
 *   1. A rerun is safe (the second pass's UPDATE sees `lml_identity_id`
 *      already populated and matches 0 rows).
 *   2. A mid-run drift from `rotation-etl` (a tubafrenzy paste-correction
 *      changing `discogs_release_id` to a different id, and the
 *      rotation-etl CASE clearing `lml_identity_id` back to NULL) doesn't
 *      get clobbered with an identity minted against the *old* Discogs
 *      id. That race manifests as a 0-row UPDATE which the orchestrator
 *      reads via `written: false` and rolls into its `raced` counter.
 *
 * Both guards together: the column has to still be NULL *and* the row
 * has to still be pointing at the same Discogs id we resolved against.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, rotation } from '@wxyc/database';

export const writeIdentityId = async (
  rotationId: number,
  discogsReleaseIdAtRead: number,
  lmlIdentityId: number
): Promise<{ written: boolean }> => {
  const updated = await db
    .update(rotation)
    .set({ lml_identity_id: lmlIdentityId })
    .where(
      and(
        eq(rotation.id, rotationId),
        isNull(rotation.lml_identity_id),
        eq(rotation.discogs_release_id, discogsReleaseIdAtRead)
      )
    )
    .returning({ id: rotation.id });
  return { written: updated.length === 1 };
};
