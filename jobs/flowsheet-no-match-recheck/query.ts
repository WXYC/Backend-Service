/**
 * Candidate query for jobs/flowsheet-no-match-recheck (BS#2176).
 *
 * Selects terminal `metadata_status = 'enriched_no_match'` track rows whose
 * `no_match_recheck_attempted_at` marker is either NULL or outside the
 * no-match TTL. `metadata_status = 'enriched_no_match'` is the idempotency
 * gate — a row this job (or the live worker, via an unrelated path) already
 * flipped off that status drops out of the candidate set on the next SELECT,
 * exactly like `rotation-release-id-backfill`'s `discogs_release_id IS NULL`
 * gate.
 *
 * Deliberately does NOT read or write `flowsheet.metadata_attempt_at` — that
 * column is the C6 gap-recovery sweep's writer-discriminator marker
 * (BS#1011 / BS#895); see `shared/database/src/schema.ts` and
 * `docs/migrations.md`'s "Attempt-at markers" section.
 *
 * Bounded by an explicit `LIMIT` (the "bounded drip, not a full-cohort
 * sweep" constraint — the no-match population is large, LML budget is the
 * binding constraint) and ordered oldest-recheck-attempted-first (`NULLS
 * FIRST` so never-attempted rows lead), `id ASC` tiebreak — every run drains
 * the longest-waiting slice of a cohort too large to visit in one pass.
 *
 * LEFT JOINs `library` on `album_id` to pre-read `discogs_unavailable`
 * (BS#1293 gate) the same way `rotation-release-id-backfill/query.ts` does —
 * a LEFT (not INNER) JOIN is required because `flowsheet.album_id` is
 * nullable (free-form entries), and those rows must still be candidates;
 * `COALESCE(..., false)` treats "no linked library row" the same as "not
 * flagged".
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate } from './orchestrate.js';

export const NO_MATCH_TTL_DAYS_ENV = 'FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS';
export const NO_MATCH_TTL_DAYS_DEFAULT = 14;

export const BATCH_SIZE_ENV = 'FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE';
export const BATCH_SIZE_DEFAULT = 200;

export const loadCandidates = async (
  noMatchTtlDays: number = NO_MATCH_TTL_DAYS_DEFAULT,
  batchSize: number = BATCH_SIZE_DEFAULT
): Promise<Candidate[]> => {
  const rows = (await db.execute(sql`
    SELECT
      f."id",
      f."artist_name",
      f."album_title",
      f."track_title",
      f."album_id",
      COALESCE(l."discogs_unavailable", false) AS "discogs_unavailable"
    FROM "wxyc_schema"."flowsheet" f
    LEFT JOIN "wxyc_schema"."library" l ON f."album_id" = l."id"
    WHERE f."metadata_status" = 'enriched_no_match'
      AND f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND (
        f."no_match_recheck_attempted_at" IS NULL
        OR f."no_match_recheck_attempted_at" <= now() - (interval '1 day' * ${noMatchTtlDays})
      )
    ORDER BY f."no_match_recheck_attempted_at" ASC NULLS FIRST, f."id" ASC
    LIMIT ${batchSize}
  `)) as unknown as Candidate[];
  return rows ?? [];
};
