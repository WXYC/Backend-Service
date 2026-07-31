/**
 * Candidate query for jobs/library-discogs-unavailable-recheck (BS#1283 /
 * epic #1280 sub-issue 3).
 *
 * Selects `library` rows (NOT `rotation` — the job scans the table its flag
 * lives on) the MD flagged `discogs_unavailable`, excluding rows rechecked
 * within the last 7 days. `ORDER BY last_discogs_recheck_at NULLS FIRST`
 * gives never-rechecked rows priority (fair queueing); `LIMIT $BATCH_SIZE`
 * prevents a stampede if a bulk-flagging pass ever lands many rows at once.
 * The partial index `library_discogs_unavailable_idx` (BS#1281, sub-issue
 * 1a) makes the `discogs_unavailable = true` predicate cheap.
 *
 * Rows lacking `artist_name` or `album_title` are excluded; LML can't
 * resolve a release without both.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate } from './orchestrate.js';

export const BATCH_SIZE_ENV = 'LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_BATCH_SIZE';
export const BATCH_SIZE_DEFAULT = 50;

export const RECHECK_WINDOW_DAYS = 7;

export const loadCandidates = async (batchSize: number = BATCH_SIZE_DEFAULT): Promise<Candidate[]> => {
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title"
    FROM "wxyc_schema"."library"
    WHERE "discogs_unavailable" = true
      AND (
        "last_discogs_recheck_at" IS NULL
        OR "last_discogs_recheck_at" <= now() - (interval '1 day' * ${RECHECK_WINDOW_DAYS})
      )
      AND "artist_name" IS NOT NULL
      AND "album_title" IS NOT NULL
    ORDER BY "last_discogs_recheck_at" NULLS FIRST, "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as Candidate[];
  return rows ?? [];
};
