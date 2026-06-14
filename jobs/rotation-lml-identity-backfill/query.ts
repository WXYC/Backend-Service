/**
 * Candidate query for jobs/rotation-lml-identity-backfill (BS#1380).
 *
 * Selects active rotation rows (`kill_date IS NULL OR > CURRENT_DATE`)
 * whose `lml_identity_id` is NULL but whose `discogs_release_id` is
 * non-NULL — i.e. rows that have an LML-resolvable Discogs handle but
 * no minted identity yet. The two-column predicate is the idempotency
 * gate: rerunning the job after a partial run, or after a tubafrenzy
 * paste landed mid-run, is safe and skips already-resolved rows.
 *
 * Rows with a NULL `discogs_release_id` are out of scope — there's no
 * source-of-truth ID to feed `resolveIdentity`. The
 * `rotation-release-id-backfill` job is the precursor that populates
 * those.
 *
 * No new index. Rotation is hundreds of active rows; the seqscan is
 * fine and matches the precedent set by
 * `jobs/rotation-release-id-backfill/query.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

export type Candidate = {
  id: number;
  discogs_release_id: number;
};

export const loadCandidates = async (): Promise<Candidate[]> => {
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "discogs_release_id"
    FROM "wxyc_schema"."rotation"
    WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
      AND "lml_identity_id" IS NULL
      AND "discogs_release_id" IS NOT NULL
    ORDER BY "id" ASC
  `)) as unknown as Candidate[];
  return rows ?? [];
};

/**
 * BS#1380 coverage gate: resolvable coverage = (active rows with
 * lml_identity_id) / (active rows with discogs_release_id). When
 * the daily cron hits >= 99.0 steady-state, BS#1381 (rotation-
 * artist-backfill switching off discogs_release_id) is unblocked.
 *
 * Denominator excludes rows with NULL discogs_release_id (no backfill
 * source) so library_identity health doesn't conflate with backfill
 * progress.
 */
export type CoverageReport = {
  active: number;
  active_with_discogs: number;
  active_with_lml: number;
  resolvable_coverage_pct: number | null;
};

export const loadCoverageReport = async (): Promise<CoverageReport> => {
  const rows = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE "kill_date" IS NULL OR "kill_date" > CURRENT_DATE) AS active,
      COUNT(*) FILTER (WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
                       AND "discogs_release_id" IS NOT NULL) AS active_with_discogs,
      COUNT(*) FILTER (WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
                       AND "discogs_release_id" IS NOT NULL
                       AND "lml_identity_id" IS NOT NULL) AS active_with_lml,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
                                 AND "discogs_release_id" IS NOT NULL
                                 AND "lml_identity_id" IS NOT NULL)
            / NULLIF(COUNT(*) FILTER (WHERE ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
                                      AND "discogs_release_id" IS NOT NULL), 0),
        2
      ) AS resolvable_coverage_pct
    FROM "wxyc_schema"."rotation"
  `)) as unknown as Array<{
    active: string | number;
    active_with_discogs: string | number;
    active_with_lml: string | number;
    resolvable_coverage_pct: string | number | null;
  }>;
  const row = rows?.[0];
  // PG returns bigints as strings via postgres.js — coerce.
  const toNumber = (raw: string | number | null): number | null => {
    if (raw === null) return null;
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    active: toNumber(row?.active ?? 0) ?? 0,
    active_with_discogs: toNumber(row?.active_with_discogs ?? 0) ?? 0,
    active_with_lml: toNumber(row?.active_with_lml ?? 0) ?? 0,
    resolvable_coverage_pct: toNumber(row?.resolvable_coverage_pct ?? null),
  };
};
