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
 * This lives in `utils/` rather than beside any one caller because all three
 * alias-aware read paths use it (`/library/query` in
 * `library-search.service.ts`, plus Both-mode trigram and request-line
 * `searchByArtist` in `library.service.ts`). One definition is what keeps the
 * match semantics from drifting between them.
 *
 * @param query Raw user query text, matched against `variant` as a single
 *   string (never tokenized).
 */
export function buildAliasHitsCte(query: string) {
  return sql`WITH alias_hits AS (
    SELECT
      asa.artist_id,
      MAX(similarity(asa.variant, ${query})) AS max_sim,
      (array_agg(asa.variant ORDER BY similarity(asa.variant, ${query}) DESC))[1] AS matched_variant,
      (array_agg(asa.source ORDER BY similarity(asa.variant, ${query}) DESC))[1] AS matched_source
    FROM ${artist_search_alias} asa
    WHERE asa.variant % ${query}
    GROUP BY asa.artist_id
  )`;
}
