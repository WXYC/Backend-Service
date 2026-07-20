/**
 * Factory for the single-boolean, strict-`true`-gated, lazily-cached
 * environment-flag config that several feature gates share verbatim
 * (`criticReviews`, `catalogSearchAlias`). Each returned config is a small
 * singleton over one env var; `getConfig()` reads the environment once and
 * caches, `loadConfig()` reads it fresh every call, and `resetConfig()` drops
 * the cache so a test that mutated the env var in `beforeEach` re-reads it.
 *
 * The strict `=== 'true'` comparison is the point of the shared helper: a flag
 * that gates an extra query or a widened SQL path must not silently enable on
 * `=1`/`TRUE`/`yes`. Callers that need more than one flag (e.g.
 * `catalogTrackSearch`, which carries two) don't use this factory.
 *
 * The returned functions close over a factory-local cache, so they stay
 * correct when destructured and re-exported as standalone named bindings
 * (`export const { getConfig, resetConfig } = createEnvFlagConfig(...)`) —
 * there is no `this` to lose.
 */
export interface EnvFlagConfig {
  enabled: boolean;
}

export interface EnvFlag {
  loadConfig(): EnvFlagConfig;
  getConfig(): EnvFlagConfig;
  resetConfig(): void;
}

export function createEnvFlagConfig(envVar: string): EnvFlag {
  let cached: EnvFlagConfig | null = null;

  function loadConfig(): EnvFlagConfig {
    return { enabled: process.env[envVar] === 'true' };
  }

  function getConfig(): EnvFlagConfig {
    if (!cached) {
      cached = loadConfig();
    }
    return cached;
  }

  function resetConfig(): void {
    cached = null;
  }

  return { loadConfig, getConfig, resetConfig };
}
