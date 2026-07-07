/**
 * Rotation identity-id loader for jobs/rotation-artist-backfill (BS#1381).
 *
 * Returns the set of `entity.release_identity.id` values on active rotation
 * rows. BS#1380 populates this column synchronously on `addToRotation` and
 * via the daily `rotation-lml-identity-backfill` drift-repair cron, so an
 * active rotation row should have a non-NULL value at steady state.
 *
 * Rows with `lml_identity_id IS NULL` are out of scope here — they belong
 * to the LML-resolve path and chaining this cron to that one would couple
 * two unrelated backfills. The exclusion is also load-bearing for the
 * `backfill.not_found` alert in BS#1402: only rows BS *believes* have a
 * valid handle should be counted in the denominator, otherwise the
 * stale-reference signal gets diluted by rows that simply haven't been
 * resolved yet.
 *
 * DISTINCT because a release identity can show up in rotation more than
 * once over its history (multiple bins, re-adds, legacy rows). One
 * refresh call is enough to warm every source/artist linked to it.
 * Ordering is by id ascending for deterministic dry-run + batch logs.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

export type RotationIdentity = { lml_identity_id: number };

export const loadActiveRotationIdentityIds = async (): Promise<number[]> => {
  const rows = (await db.execute(sql`
    SELECT DISTINCT "lml_identity_id"
    FROM "wxyc_schema"."rotation"
    WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
      AND "lml_identity_id" IS NOT NULL
    ORDER BY "lml_identity_id" ASC
  `)) as unknown as RotationIdentity[];
  return (rows ?? []).map((r) => r.lml_identity_id);
};
