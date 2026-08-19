/**
 * Candidate query for jobs/flowsheet-no-match-recheck (BS#2176, BS#2218).
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
 * binding constraint). Two priority tiers, in order:
 *
 *   1. Never-attempted rows (`no_match_recheck_attempted_at IS NULL`,
 *      `NULLS FIRST`) — newest-first (`id DESC`) as of BS#2218. Prod
 *      measurement on 2026-08-18 found 2026 playcuts were 4,880 of a
 *      137,340-row cohort and sorted LAST under the pre-fix `id ASC`
 *      tiebreak — 132,460 older rows sat ahead of them, so even a
 *      perfectly functioning job needed ~5.5 months to reach a row anyone
 *      can currently see. `id` is monotonically assigned at insert time, so
 *      `id DESC` recovers recent playcuts first while 22 years of history
 *      drains behind them; `add_time DESC` would express the same intent
 *      more directly but `id` is both already indexed here
 *      (`flowsheet_no_match_recheck_idx`, migration 0151) and exactly as
 *      correct for this cohort (the BS#2218 measurement's id-to-year bands
 *      were clean), so it's the smaller diff.
 *   2. Previously-attempted, TTL-expired rows
 *      (`no_match_recheck_attempted_at <= now() - TTL`) — unchanged,
 *      oldest-attempted-first, `id ASC` tiebreak.
 *
 * These can't be expressed as a single `ORDER BY col ASC NULLS FIRST, id
 * <dir>` (a single tiebreak column can't flip direction depending on which
 * tier a row is in), so the tiebreak is two mutually-exclusive CASE
 * expressions: the never-attempted tier's `id` DESC, and the
 * previously-attempted tier's `id` ASC. Each CASE evaluates to NULL for
 * rows outside its own tier, which is harmless — those rows are already
 * separated onto the correct side of the primary `NULLS FIRST` sort key, so
 * the tiebreak's NULL-ordering default never has to arbitrate across tiers.
 *
 * INDEXING NOTE — this ordering is deliberately NOT index-servable, and the
 * cost is real, so state it plainly rather than eliding it.
 * `flowsheet_no_match_recheck_idx` (migration 0151) is
 * `(no_match_recheck_attempted_at NULLS FIRST, id ASC)`, built for the
 * pre-fix `ORDER BY`. A B-tree can never match an `ORDER BY <CASE
 * expression>` key, so the index survives only as the PREDICATE match (its
 * partial `WHERE` is exactly this cohort, keeping the plan off a seq scan of
 * the ~2.6M-row / ~1.7 GB `flowsheet` heap); it no longer supplies the sort
 * order. Consequences, both of which the pre-fix query avoided:
 *
 *   - The plan must materialize and Sort the WHOLE candidate set before
 *     `LIMIT`/`OFFSET` can apply — not just the never-attempted tier.
 *     Incremental sort can use the leading `no_match_recheck_attempted_at`
 *     key, but every never-attempted row shares one NULL group, so that
 *     group is sorted in a single shot regardless.
 *   - The sort input is the projected row (three `text` columns among
 *     them), so the heap is visited for every candidate, where the pre-fix
 *     plan short-circuited at `LIMIT` after roughly one page of
 *     index-ordered rows.
 *
 * At the 2026-08-18 cohort size (137,340) that is a ~20 MB sort — above the
 * default `work_mem`, so an external merge — plus full-cohort heap access,
 * four times a day. Judged acceptable because this job's container sets
 * `DB_STATEMENT_TIMEOUT_MS=60000` (see `Dockerfile.flowsheet-no-match-recheck`;
 * the 5s default the API containers run under, and that migration 0151's
 * docstring cites, does NOT apply here), which leaves an order of magnitude
 * of headroom. If the cohort grows enough to erode that, the fix is a
 * companion partial index `(no_match_recheck_attempted_at NULLS FIRST, id
 * DESC)` built out-of-band with `CONCURRENTLY` per migration 0151's
 * production-ops runbook — deliberately deferred rather than bundled here,
 * since a second index on a hot ~2.6M-row table costs write amplification on
 * every live flowsheet INSERT/UPDATE to buy latency this job does not need.
 *
 * BS#2218 also added `cursorOffset` (default 0, backward compatible) and
 * the sibling `countCandidates` export: an OFFSET-based starvation guard so
 * a batch of rows that transients on every call — leaving
 * `no_match_recheck_attempted_at` untouched per the BS#1977 / BS#2179 review
 * HIGH 2 contract — cannot occupy the same position in this ordering every
 * run forever. See `jobs/flowsheet-no-match-recheck/watermark.ts` for the
 * cursor's persistence and wraparound arithmetic, and migration 0152 for why
 * it lives on `cronjob_runs` rather than a new table. This query only
 * accepts the already-resolved offset; it has no opinion on how the caller
 * got it.
 *
 * LEFT JOINs `library` on `album_id` to pre-read `discogs_unavailable`
 * (BS#1293 gate) the same way `rotation-release-id-backfill/query.ts` does —
 * a LEFT (not INNER) JOIN is required because `flowsheet.album_id` is
 * nullable (free-form entries), and those rows must still be candidates;
 * `COALESCE(..., false)` treats "no linked library row" the same as "not
 * flagged". `countCandidates` omits this join — it doesn't select
 * `discogs_unavailable`, so there's nothing for it to serve.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate } from './orchestrate.js';

export const NO_MATCH_TTL_DAYS_ENV = 'FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS';
export const NO_MATCH_TTL_DAYS_DEFAULT = 14;

export const BATCH_SIZE_ENV = 'FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE';
export const BATCH_SIZE_DEFAULT = 200;

/**
 * The candidate predicate shared verbatim between `loadCandidates` and
 * `countCandidates` — a single source of truth so `countCandidates`'s total
 * (the denominator the BS#2218 cursor wraps against) can never silently
 * drift from the population `loadCandidates` actually selects from.
 */
const candidatePredicate = (noMatchTtlDays: number): SQL => sql`
      f."metadata_status" = 'enriched_no_match'
      AND f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND (
        f."no_match_recheck_attempted_at" IS NULL
        OR f."no_match_recheck_attempted_at" <= now() - (interval '1 day' * ${noMatchTtlDays})
      )
`;

export const loadCandidates = async (
  noMatchTtlDays: number = NO_MATCH_TTL_DAYS_DEFAULT,
  batchSize: number = BATCH_SIZE_DEFAULT,
  cursorOffset: number = 0
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
    WHERE ${candidatePredicate(noMatchTtlDays)}
    ORDER BY
      f."no_match_recheck_attempted_at" ASC NULLS FIRST,
      CASE WHEN f."no_match_recheck_attempted_at" IS NULL THEN f."id" END DESC,
      CASE WHEN f."no_match_recheck_attempted_at" IS NOT NULL THEN f."id" END ASC
    LIMIT ${batchSize}
    OFFSET ${cursorOffset}
  `)) as unknown as Candidate[];
  return rows ?? [];
};

/**
 * Total rows matching `candidatePredicate` — the denominator
 * `jobs/flowsheet-no-match-recheck/watermark.ts`'s cursor wraps the BS#2218
 * OFFSET against. Deliberately no LEFT JOIN / ORDER BY / LIMIT / OFFSET: a
 * plain count needs none of them, and skipping the join avoids paying for a
 * column (`discogs_unavailable`) this function never returns.
 */
export const countCandidates = async (noMatchTtlDays: number = NO_MATCH_TTL_DAYS_DEFAULT): Promise<number> => {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS "count"
    FROM "wxyc_schema"."flowsheet" f
    WHERE ${candidatePredicate(noMatchTtlDays)}
  `)) as unknown as Array<{ count: number }>;
  return Number(rows?.[0]?.count ?? 0);
};
