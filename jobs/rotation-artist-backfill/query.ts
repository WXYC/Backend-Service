/**
 * Rotation-release-id loader for jobs/rotation-artist-backfill (BS#1361).
 *
 * Returns the set of Discogs release ids on active rotation rows. We
 * deliberately read from `rotation.discogs_release_id` (BS#1029) rather
 * than joining through `library`/`library_identity` so the script is one
 * SELECT with no cross-table assumptions. Rows without a populated
 * `discogs_release_id` are out of scope here — rotation-release-id-backfill
 * is the owner of resolving those, and chaining this cron to it would
 * couple two unrelated backfills.
 *
 * Distinct on `discogs_release_id` because a release can appear in
 * rotation more than once over its history (multiple bins, re-adds,
 * legacy rows). One LML release call is enough to surface all credited
 * artists; ordering is by id ascending for deterministic dry-run output.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

export type RotationRelease = { discogs_release_id: number };

export const loadActiveRotationReleaseIds = async (): Promise<number[]> => {
  const rows = (await db.execute(sql`
    SELECT DISTINCT "discogs_release_id"
    FROM "wxyc_schema"."rotation"
    WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
      AND "discogs_release_id" IS NOT NULL
    ORDER BY "discogs_release_id" ASC
  `)) as unknown as RotationRelease[];
  return (rows ?? []).map((r) => r.discogs_release_id);
};
