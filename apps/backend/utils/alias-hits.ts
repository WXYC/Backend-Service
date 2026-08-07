import { sql } from 'drizzle-orm';
import { artist_search_alias } from '@wxyc/database';

/**
 * Build the `alias_hits` CTE used by the UNION ALL alias-aware search paths
 * (BS#1318). The CTE runs the trigram bitmap scan over `artist_search_alias`
 * exactly once and groups by `artist_id`, yielding (artist_id, max_sim,
 * matched_variant, matched_source) for every artist whose alias substrate
 * matches `query`. Callers join this CTE on `artist_id` rather than running
 * a correlated LATERAL per candidate row.
 *
 * Replacement for the previous `LEFT JOIN LATERAL` design: the LATERAL was
 * correlated on `asa.artist_id = library.artist_id`, which steered the
 * planner onto the PK btree and filtered `variant % q` row-by-row, never
 * touching the GIN trigram index. The CTE form lets the planner pick the
 * trigram bitmap scan once and hash-join into the outer query.
 *
 * BS#2018 adds the `similarity(...) >= minSimilarity` floor. It is a FILTER
 * layered on top of `%`, deliberately not a replacement: `%` is the operator
 * the GIN trigram index (`artist_search_alias_variant_trgm_idx`) answers, so
 * dropping it would cost the bitmap scan BS#1318 exists to preserve. pg_trgm's
 * own 0.30 threshold is too loose for short variants — because callers join
 * this CTE on `artist_id`, ONE colliding variant admits an artist's entire
 * discography — so the floor re-tightens it. See
 * `apps/backend/config/catalogSearchAlias.ts` for how 0.40 was calibrated.
 *
 * This lives in `utils/` rather than beside any one caller because all three
 * alias-aware read paths use it (`/library/query` in
 * `library-search.service.ts`, plus Both-mode trigram and request-line
 * `searchByArtist` in `library.service.ts`). Keeping one definition is what
 * stops the floor and the match semantics from drifting between them — which
 * is exactly the class of bug BS#2018 was.
 *
 * Note this reads only `variant`. The substrate also carries `active` and
 * `confidence` per row, and neither has ever gated catalog search — BS#1383
 * pins that `discogs_member` rows must surface here even though the concerts
 * resolver filters them. Narrowing on those columns is a product call about
 * which alias sources the catalog trusts, not a calibration, so it is out of
 * scope for the BS#2018 floor and left as-is deliberately.
 *
 * @param query Raw user query text, matched against `variant` as a single
 *   string (never tokenized).
 * @param minSimilarity The BS#2018 floor. Passed in rather than read from
 *   config here so this stays pure, and so `searchLibrary`'s documented
 *   read-the-config-once-per-request invariant is not quietly broken by a
 *   helper in another file.
 */
export function buildAliasHitsCte(query: string, minSimilarity: number) {
  return sql`WITH alias_hits AS (
    SELECT
      asa.artist_id,
      MAX(similarity(asa.variant, ${query})) AS max_sim,
      (array_agg(asa.variant ORDER BY similarity(asa.variant, ${query}) DESC))[1] AS matched_variant,
      (array_agg(asa.source ORDER BY similarity(asa.variant, ${query}) DESC))[1] AS matched_source
    FROM ${artist_search_alias} asa
    WHERE asa.variant % ${query} AND similarity(asa.variant, ${query}) >= ${minSimilarity}
    GROUP BY asa.artist_id
  )`;
}

/**
 * Leading ORDER BY term for every alias-aware read path: sort rows that
 * matched ONLY through a *fuzzy* alias variant after everything else.
 *
 * `FALSE < TRUE` in Postgres, so ASC puts the non-demoted rows first. Branch
 * (a) rows have a NULL `alias_max_sim`, and `FALSE AND NULL` short-circuits to
 * FALSE, so they land in the leading tier without a COALESCE.
 *
 * ## Why the `< 1` guard
 *
 * BS#2018 introduced this tier unconditionally, against a 0.333 typo collision
 * ("Monore" for a `monolake` query) that sorted identically to an exact hit.
 * The complaint was always about *fuzzy* variants; demoting exact ones was
 * collateral. `similarity()` returns exactly 1 only when the query string and
 * the variant are the same string modulo case and trigram padding — i.e. the
 * query IS a registered name for that artist. That is a stronger claim than a
 * 0.31 trigram smear across some unrelated canonical name, so tiering it below
 * one inverts the ranking the alias substrate exists to provide.
 *
 * On `/library/query` the collateral was survivable: it paginates, so a
 * demoted row is on a later page. The two `library.service.ts` paths emit a
 * bare `LIMIT` with no OFFSET, so for them demoted means *deleted* — measured
 * on a prod-shaped clone, a `monolake` query has 13 real rows scoring <= 0.40
 * ahead of the tier, which pushes a 1.0 alias hit past position 13 on a
 * surface whose default limit is 5. BS#1383's `discogs_member` fixture (an
 * exact variant on a different artist) is exactly that case.
 *
 * ## Why one shared builder
 *
 * All three alias-aware paths lead their sort with this term, and the tier
 * has to mean the same thing in all three or the same query ranks differently
 * on two endpoints that are supposed to agree. Hand-copying the literal is
 * how BS#2018 shipped with the floor applied to one path and not the others.
 *
 * Returns a fresh `SQL` per call rather than a module-level constant so
 * callers can never share mutable builder state.
 */
export function buildFuzzyAliasTier() {
  return sql`(alias_max_sim IS NOT NULL AND alias_max_sim < 1) ASC`;
}
