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
 * Leading ORDER BY term for alias-aware paths that sort by a caller-chosen
 * column: sort every alias-only row after every row that matched the query
 * text itself (BS#2018 Fix 1).
 *
 * `FALSE < TRUE` in Postgres, so ASC puts the non-alias rows first. Branch (a)
 * rows have a NULL `alias_max_sim`, so the predicate is FALSE for them.
 *
 * Used by `/library/query` only. See `buildFuzzyAliasTier` for the narrowed
 * form the two relevance-ranked paths use, and why the two deliberately differ
 * rather than being unified.
 */
export function buildAliasOnlyTier() {
  return sql`(alias_max_sim IS NOT NULL) ASC`;
}

/**
 * Leading ORDER BY term for alias-aware paths that sort by RELEVANCE: demote
 * rows that matched only through a *fuzzy* alias variant, and leave exact ones
 * where their score puts them.
 *
 * Same shape as `buildAliasOnlyTier` plus a `< 1` guard, and `FALSE AND NULL`
 * short-circuits to FALSE so branch (a) still needs no COALESCE.
 *
 * ## Why the guard
 *
 * BS#2018 introduced the tier unconditionally, against a 0.333 typo collision
 * ("Monore" for a `monolake` query) that sorted identically to an exact hit.
 * The complaint was always about *fuzzy* variants; demoting exact ones was
 * collateral. On `/library/query` that collateral is survivable — it
 * paginates, so a demoted row is on a later page. These two paths emit a bare
 * `LIMIT` with no OFFSET, so demoted means *deleted*: measured on a
 * prod-shaped clone, a `monolake` query has 13 real rows scoring <= 0.40 ahead
 * of the tier, which pushes a 1.0 alias hit past position 13 on a surface
 * whose default limit is 5. BS#1383's `discogs_member` fixture — an exact
 * variant on a different artist — is exactly that case.
 *
 * ## Why NOT on `/library/query`
 *
 * An exemption is only meaningful if something ranks the exempted row
 * afterwards. That path orders by the caller's `sort` column, so an exempt row
 * is not "ranked on its merits", it is alphabetized among the real matches —
 * one exact-variant artist with 30 early-alphabet albums would fill page 0.
 * The two forms are separate builders, not one parameterized builder, so that
 * asymmetry is visible at both call sites instead of hiding behind a boolean.
 *
 * ## What `alias_max_sim = 1` actually means
 *
 * Less than it looks. pg_trgm splits on non-alphanumerics, pads each word, and
 * unions the trigrams into a DEDUPLICATED set, so equality of trigram sets is
 * not equality of strings: `similarity('Duke Ellington', 'Ellington Duke')`
 * and `similarity('The The', 'the')` are both exactly 1. A query that merely
 * permutes a registered variant, or that is one repeated word of it, is
 * therefore treated as exact here.
 *
 * That is wider than the argument above, and accepted rather than overlooked.
 * Tightening it would mean comparing normalized strings instead of scores,
 * which is a different match semantics than the `%` operator the GIN index
 * answers (BS#1318) and would not survive the `MAX(...)` aggregation in the
 * CTE. The failure mode is bounded: a permuted variant is still a variant of
 * that artist, so the row is relevant — it is only the *confidence* that is
 * overstated, and `buildDirectMatchTieBreak` keeps it behind a genuine
 * text match at equal score.
 */
export function buildFuzzyAliasTier() {
  return sql`(alias_max_sim IS NOT NULL AND alias_max_sim < 1) ASC`;
}

/**
 * Trailing ORDER BY term for the relevance-ranked paths: at EQUAL relevance,
 * prefer the row that matched the query text over one that matched a variant.
 *
 * Belongs after the `GREATEST(...)` term, never before it — ahead of the score
 * it would be a second unconditional tier and undo `buildFuzzyAliasTier`.
 *
 * `buildFuzzyAliasTier` removed the only signal separating a direct match from
 * an alias match once both reach 1.0 (real: `similarity(artist_name, q) = 1`;
 * alias: `alias_max_sim = 1`). Without this term every preceding term ties and
 * `id ASC` decides — that is, catalog age decides. The concrete shape is a
 * `discogs_member` variant naming a band member who also has solo records:
 * query the member's name and the band's whole discography ties with the
 * member's own, resolved by whichever ids are lower.
 *
 * On both current callers this is unreachable, and deliberately kept anyway.
 * `searchLibraryByTrigramBoth` runs only after the tsvector tier returns zero
 * rows, and any real row scoring 1.0 on trigram necessarily matches
 * `websearch_to_tsquery` too (identical trigram sets imply the same word set),
 * so the tsvector tier short-circuits before this SQL is ever reached.
 * `searchByArtist` has no tsvector tier and no callers (BS#2022). The guard
 * costs one ORDER BY term and holds the invariant locally, rather than
 * borrowing it from a different subsystem's short-circuit — which is the kind
 * of load-bearing coupling that breaks silently when the other subsystem
 * changes.
 */
export function buildDirectMatchTieBreak() {
  return sql`(alias_max_sim IS NOT NULL) ASC`;
}
