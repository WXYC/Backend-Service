/**
 * Candidate query for jobs/rotation-release-id-backfill (BS#1029).
 *
 * Selects active rotation rows (`kill_date IS NULL OR > CURRENT_DATE`) whose
 * `discogs_release_id` is NULL. The NULL predicate is the idempotency gate —
 * rerunning the job after a partial run, or after a tubafrenzy paste landed
 * mid-run, is safe and skips already-populated rows.
 *
 * Rows lacking `artist_name` or `album_title` are also excluded; LML can't
 * resolve a release without both columns, so writing them as `unresolved`
 * would only add noise to the counter.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate } from './orchestrate.js';

export const loadCandidates = async (): Promise<Candidate[]> => {
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
    ORDER BY "id" ASC
  `)) as unknown as Candidate[];
  return rows ?? [];
};
