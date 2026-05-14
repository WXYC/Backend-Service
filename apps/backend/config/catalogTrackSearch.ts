/**
 * Configuration for the catalog track-search cascade.
 *
 * `searchLibrary` falls back through three layers when the primary
 * tsvector+trigram search returns zero hits: Track 1 (CTA — compilation
 * track-artist) and Track 2 (Discogs `/lookup` via LML). Each layer is
 * gated by its own flag so rollout can be staged independently.
 *
 * Both flags default to `false` so production behavior is unchanged until
 * an operator opts in. See the plan:
 * https://github.com/WXYC/wiki/blob/main/plans/catalog-track-search.md
 */

export interface CatalogTrackSearchConfig {
  /** Track 1 — CTA (compilation track-artist) fuzzy fallback. */
  ctaEnabled: boolean;

  /** Track 2 — Discogs `/lookup` fallback proxied through LML. */
  discogsEnabled: boolean;
}

/**
 * Load the config from environment variables. Both flags are strict-`true`
 * gated (anything other than the literal string `'true'` reads as `false`)
 * so an accidental `CATALOG_TRACK_SEARCH_CTA_ENABLED=1` does not silently
 * enable a fallback layer in production.
 */
export function loadConfig(): CatalogTrackSearchConfig {
  return {
    ctaEnabled: process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED === 'true',
    discogsEnabled: process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED === 'true',
  };
}

/**
 * Singleton config instance.
 */
let _config: CatalogTrackSearchConfig | null = null;

/**
 * Get the configuration, loading it from the environment on first call.
 */
export function getConfig(): CatalogTrackSearchConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset the cached singleton. Tests that mutate
 * `process.env.CATALOG_TRACK_SEARCH_*_ENABLED` between cases must call this
 * in `beforeEach` so the next `getConfig()` re-reads the environment.
 */
export function resetConfig(): void {
  _config = null;
}
