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
