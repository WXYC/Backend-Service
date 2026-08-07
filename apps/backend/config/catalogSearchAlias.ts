/**
 * Configuration for alias-aware catalog search (artist-search-alias plan PR 5).
 *
 * When enabled, the three trigram read paths
 * (`searchLibraryByTrigramBoth`, `searchByArtist`, `/library/query`) extend
 * their SQL with a `WITH alias_hits` CTE over `artist_search_alias` joined on
 * `library.artist_id` (BS#1318 ALT1). The flag is strict-`true` gated so an
 * accidental `CATALOG_SEARCH_ALIAS_ENABLED=1` does not silently widen the
 * search path.
 *
 * Defaults to `false` so production behavior is unchanged until an operator
 * opts in. See: `Backend-Service/plans/artist-search-alias.md` §PR 5.
 *
 * Tests that mutate either env var between cases must call `resetConfig()` in
 * `beforeEach` so the next `getConfig()` re-reads the environment.
 */

/**
 * pg_trgm's own `similarity_threshold` default — the bar the `%` operator
 * applies. Named here because the BS#2018 floor is layered ON TOP of `%`,
 * never in place of it: the `%` predicate is what drives the GIN index
 * (`artist_search_alias_variant_trgm_idx`), so setting `minSimilarity` below
 * this value cannot widen matching. The knob only ever tightens.
 */
export const PG_TRGM_DEFAULT_THRESHOLD = 0.3;

/**
 * BS#2018 default alias-match floor.
 *
 * pg_trgm's 0.30 is far too permissive for short alias variants, whose
 * trigram sets are small enough that unrelated strings collide at a fixed
 * ratio. Because the alias branch INNER JOINs on `artist_id`, ONE colliding
 * variant admits an artist's entire discography — `similarity('Monore',
 * 'monolake') = 0.333` (a misprint among Discogs artist 450691's 42 name
 * variations) put all 14 Bill Monroe albums into a search for Monolake.
 *
 * 0.40 was picked by measuring every known collision against every known
 * legitimate match rather than by feel; the table lives in
 * `tests/unit/config/catalog-search-alias-config.test.ts`, which fails if
 * this constant moves out from between them. The margin is thin — the
 * tightest true positive (`oh sees` -> `Osees`) sits at exactly 0.40, so
 * 0.50 is NOT a safe "rounder" choice. Re-measure before changing this.
 */
export const DEFAULT_ALIAS_MIN_SIMILARITY = 0.4;

export interface CatalogSearchAliasConfig {
  /** Strict-`true` gate on the whole alias-aware search path. */
  enabled: boolean;

  /**
   * Minimum `similarity(artist_search_alias.variant, q)` for an alias row to
   * count as a match, applied as a filter on top of the indexable `%`
   * predicate. Operator-tunable via `CATALOG_SEARCH_ALIAS_MIN_SIMILARITY` so
   * the calibration can be backed out without a code change if it turns out
   * to suppress legitimate matches in production.
   */
  minSimilarity: number;
}

/**
 * Parse the floor from its env var. An unusable value falls back to the
 * shipped default rather than clamping: clamping a plausible "percent" typo
 * (`40`) to 1.0 would match nothing and silently disable the alias feature
 * outright, which is a far worse failure than ignoring the override.
 *
 * Both the fallback and the below-`%`-threshold no-op are logged. This knob
 * exists so an operator can back the calibration out mid-incident; a typo
 * that silently leaves the shipped default in place would read to them as
 * "the floor wasn't the cause," which is the worst possible wrong conclusion
 * to hand someone at that moment.
 */
function parseMinSimilarity(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ALIAS_MIN_SIMILARITY;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[catalogSearchAlias] CATALOG_SEARCH_ALIAS_MIN_SIMILARITY=${JSON.stringify(raw)} is not a number in [0, 1]; ` +
        `falling back to ${DEFAULT_ALIAS_MIN_SIMILARITY}. The floor is a similarity ratio, not a percentage — ` +
        `use 0.4, not 40.`
    );
    return DEFAULT_ALIAS_MIN_SIMILARITY;
  }
  if (parsed < PG_TRGM_DEFAULT_THRESHOLD) {
    console.warn(
      `[catalogSearchAlias] CATALOG_SEARCH_ALIAS_MIN_SIMILARITY=${parsed} is below pg_trgm's own ` +
        `similarity_threshold (${PG_TRGM_DEFAULT_THRESHOLD}) and therefore has no effect: the indexable \`%\` ` +
        `predicate still rejects everything under ${PG_TRGM_DEFAULT_THRESHOLD}. This knob can only tighten alias ` +
        `matching, never loosen it.`
    );
  }
  return parsed;
}

/** Read the config fresh from the environment. */
export function loadConfig(): CatalogSearchAliasConfig {
  return {
    enabled: process.env.CATALOG_SEARCH_ALIAS_ENABLED === 'true',
    minSimilarity: parseMinSimilarity(process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY),
  };
}

let _config: CatalogSearchAliasConfig | null = null;

export function getConfig(): CatalogSearchAliasConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** Drop the cached singleton so the next `getConfig()` re-reads the env. */
export function resetConfig(): void {
  _config = null;
}
