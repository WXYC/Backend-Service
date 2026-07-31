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
 *
 * BS#1294 (1c): LEFT JOINs `library` on `rotation.album_id` to pre-read
 * `discogs_unavailable` at candidate-load time (this job's existing
 * batched-candidate pattern — it does not read per-row today) and forwards
 * it through `orchestrate.ts` to the lookupMetadata gate (BS#1293). A LEFT
 * (not INNER) JOIN is required: `rotation.album_id` is nullable (freeform /
 * unlinked rotation rows), and those rows must still be candidates —
 * `COALESCE(..., false)` treats "no linked library row" the same as "not
 * flagged".
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate } from './orchestrate.js';

export const NO_MATCH_TTL_DAYS_ENV = 'ROTATION_RELEASE_ID_NO_MATCH_TTL_DAYS';
export const NO_MATCH_TTL_DAYS_DEFAULT = 30;

export const loadCandidates = async (noMatchTtlDays: number = NO_MATCH_TTL_DAYS_DEFAULT): Promise<Candidate[]> => {
  const rows = (await db.execute(sql`
    SELECT
      r."id",
      r."artist_name",
      r."album_title",
      COALESCE(l."discogs_unavailable", false) AS "discogs_unavailable"
    FROM "wxyc_schema"."rotation" r
    LEFT JOIN "wxyc_schema"."library" l ON r."album_id" = l."id"
    WHERE (r."kill_date" IS NULL OR r."kill_date" > CURRENT_DATE)
      AND r."discogs_release_id" IS NULL
      AND r."artist_name" IS NOT NULL
      AND r."album_title" IS NOT NULL
      AND (
        r."discogs_release_id_resolve_attempted_at" IS NULL
        OR r."discogs_release_id_resolve_attempted_at" <= now() - (interval '1 day' * ${noMatchTtlDays})
      )
    ORDER BY r."id" ASC
  `)) as unknown as Candidate[];
  return rows ?? [];
};
