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
 *      more directly but `id` is both already the indexed
 *      tiebreak for this cohort (`flowsheet_no_match_recheck_id_desc_idx`,
 *      migration 0153) and exactly as correct (the BS#2218 measurement's
 *      id-to-year bands were clean), so it's the smaller diff.
 *   2. Previously-attempted, TTL-expired rows
 *      (`no_match_recheck_attempted_at <= now() - TTL`) — unchanged in the
 *      way that matters: oldest-attempted-first. Its `id` tiebreak rides
 *      along to `DESC` with the tier above, which is immaterial — that
 *      tiebreak only arbitrates rows sharing an identical
 *      `no_match_recheck_attempted_at`, and every stamp comes from its own
 *      single-row UPDATE evaluating `now()` in its own transaction, so ties
 *      do not occur in practice.
 *
 * That shared direction is why the whole thing stays a plain two-key
 * `ORDER BY` rather than a pair of mutually-exclusive `CASE` expressions
 * (one per tier, so each tier could keep its own direction). The `CASE`
 * form works, but it costs more than the tie it protects is worth: a
 * B-tree can never match an `ORDER BY <CASE expression>` key, so it also
 * forecloses the index remedy described below.
 *
 * INDEXING NOTE — this `ORDER BY` REQUIRES `flowsheet_no_match_recheck_id_desc_idx`
 * (migration 0153). It is not a nice-to-have, and the reason is worth keeping
 * because the first version of this change got it wrong.
 *
 * The BS#2176 index (migration 0151) was keyed `(no_match_recheck_attempted_at
 * NULLS FIRST, id ASC)`, matching the pre-fix ordering. A B-tree can only
 * supply a mixed-direction order if it was built with those directions, so
 * flipping the tiebreak to `id DESC` left it able to serve the PREDICATE
 * (its partial `WHERE` is exactly this cohort) but not the sort. The planner
 * then read every matching row and top-N heapsorted it. Measured on prod
 * 2026-08-18, same predicate, `LIMIT 200 OFFSET 0`, A/B on the tiebreak alone:
 *
 *   ORDER BY ... id ASC   ->     200 rows scanned,     76 ms
 *   ORDER BY ... id DESC  -> 137,278 rows scanned, 41,326 ms
 *
 * A ~542x regression: `Buffers: shared hit=27246 read=95110`, `I/O Timings:
 * read=39982 ms` — 97% of the runtime is heap I/O, ~743 MB per run — and it
 * did NOT improve warm (41,172 ms cold -> 41,326 ms warm), so that is steady
 * state, not a cold cache. Against this job container's
 * `DB_STATEMENT_TIMEOUT_MS=60000` (see `Dockerfile.flowsheet-no-match-recheck`;
 * the 5 s default the API containers run under, and that migration 0151's
 * docstring cites, does NOT apply here) that is ~19 s of headroom on a cohort
 * that grows — and crossing 60 s would make the job do nothing at all, a
 * strictly worse failure than the stall BS#2218 exists to fix.
 *
 * Migration 0153 therefore REPLACES 0151's index with the same partial
 * predicate re-keyed to `id DESC NULLS FIRST` (the null ordering matters:
 * `ORDER BY id DESC` means `DESC NULLS FIRST`, and an index disagreeing on
 * that does not match the query's pathkeys, even though `id` is the never-null
 * primary key). Replace rather than accompany: this query is the index's only
 * consumer, the predicate is byte-identical so any predicate-only planner use
 * is unaffected, and two near-identical partial B-trees on a live-written
 * ~2.6M-row table is pure write amplification. The expected plan is once again
 * a no-sort index scan short-circuiting at `LIMIT` — the query still visits
 * the heap for `artist_name`/`album_title`/`track_title`/`album_id`, which the
 * index does not cover, so a no-sort scan rather than an index-only scan.
 *
 * Note this remedy exists ONLY because the tiebreak is a plain sort key. Under
 * the `CASE`-per-tier form described above, no index could have fixed it.
 *
 * If the cohort ever outgrows even the indexed plan, the next lever is a
 * deferred join: sort `id` alone in an inner `LIMIT`/`OFFSET` subquery over
 * columns the index already holds, then join back to `flowsheet`/`library`
 * for the surviving `batchSize` rows.
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
      f."id" DESC
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
