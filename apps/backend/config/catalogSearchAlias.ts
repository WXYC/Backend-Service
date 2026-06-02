/**
 * Configuration for alias-aware catalog search (artist-search-alias plan PR 5).
 *
 * When enabled, the three trigram read paths
 * (`searchLibraryByTrigramBoth`, `searchByArtist`, `/library/query`) extend
 * their SQL with a `LEFT JOIN LATERAL` over `artist_search_alias` keyed on
 * `library.artist_id`. The flag is strict-`true` gated so an accidental
 * `CATALOG_SEARCH_ALIAS_ENABLED=1` does not silently widen the search path.
 *
 * Defaults to `false` so production behavior is unchanged until an operator
 * opts in. See: `Backend-Service/plans/artist-search-alias.md` §PR 5.
 */

export interface CatalogSearchAliasConfig {
  enabled: boolean;
}

export function loadConfig(): CatalogSearchAliasConfig {
  return {
    enabled: process.env.CATALOG_SEARCH_ALIAS_ENABLED === 'true',
  };
}

let _config: CatalogSearchAliasConfig | null = null;

export function getConfig(): CatalogSearchAliasConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset the cached singleton. Tests that mutate
 * `process.env.CATALOG_SEARCH_ALIAS_ENABLED` between cases must call this
 * in `beforeEach` so the next `getConfig()` re-reads the environment.
 */
export function resetConfig(): void {
  _config = null;
}
