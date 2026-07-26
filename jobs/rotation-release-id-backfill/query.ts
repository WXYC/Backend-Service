/**
 * Candidate query for jobs/rotation-release-id-backfill (BS#1029).
 *
 * Selects active rotation rows (`kill_date IS NULL OR > CURRENT_DATE`) whose
 * `discogs_release_id` is NULL and whose release-id resolve marker is either
 * NULL or outside the no-match TTL. The NULL `discogs_release_id` predicate is
 * the idempotency gate — rerunning the job after a partial run, or after a
 * tubafrenzy paste landed mid-run, is safe and skips already-populated rows.
 *
 * Rows lacking `artist_name` or `album_title` are also excluded; LML can't
 * resolve a release without both columns, so writing them as `unresolved`
 * would only add noise to the counter.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate } from './orchestrate.js';

export const NO_MATCH_TTL_DAYS_ENV = 'ROTATION_RELEASE_ID_NO_MATCH_TTL_DAYS';
export const NO_MATCH_TTL_DAYS_DEFAULT = 30;

export const loadCandidates = async (noMatchTtlDays: number = NO_MATCH_TTL_DAYS_DEFAULT): Promise<Candidate[]> => {
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title"
    FROM "wxyc_schema"."rotation"
    WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
      AND "discogs_release_id" IS NULL
      AND "artist_name" IS NOT NULL
      AND "album_title" IS NOT NULL
      AND (
        "discogs_release_id_resolve_attempted_at" IS NULL
        OR "discogs_release_id_resolve_attempted_at" <= now() - (interval '1 day' * ${noMatchTtlDays})
      )
    ORDER BY "id" ASC
  `)) as unknown as Candidate[];
  return rows ?? [];
};
