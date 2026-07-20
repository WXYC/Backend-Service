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
 *
 * The singleton mechanics (strict-`true` parse, lazy cache, `resetConfig` test
 * hook) come from the shared {@link createEnvFlagConfig} factory. Tests that
 * mutate `process.env.CATALOG_SEARCH_ALIAS_ENABLED` between cases must call
 * `resetConfig()` in `beforeEach` so the next `getConfig()` re-reads the env.
 */
import { createEnvFlagConfig, type EnvFlagConfig } from './envFlag.js';

export type CatalogSearchAliasConfig = EnvFlagConfig;

export const { loadConfig, getConfig, resetConfig } = createEnvFlagConfig('CATALOG_SEARCH_ALIAS_ENABLED');
