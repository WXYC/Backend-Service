/**
 * Factory for the single-boolean, strict-`true`-gated, lazily-cached
 * environment-flag config that several feature gates share verbatim
 * (`criticReviews`, `donate`). Each returned config is a small singleton over one env
 * var; `getConfig()` reads the environment once and caches, `loadConfig()`
 * reads it fresh every call, and `resetConfig()` drops the cache so a test
 * that mutated the env var in `beforeEach` re-reads it.
 *
 * The strict `=== 'true'` comparison is the point of the shared helper: a flag
 * whose accidental enablement is expensive or user-visible must not silently
 * trip on `=1`/`TRUE`/`yes`. What "expensive" means varies by consumer, and
 * the factory does not care — `criticReviews` gates an extra query on a hot
 * serve path, while `donate` gates neither a query nor SQL, only a boolean
 * field on the public `GET /config` document whose true value puts a
 * fundraiser button in front of listeners. Callers that need more than one setting don't use this
 * factory — `catalogTrackSearch` carries two flags, and `catalogSearchAlias`
 * pairs its flag with the BS#2018 `minSimilarity` floor — but they hand-roll
 * the same strict-`true` comparison for their boolean members.
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
