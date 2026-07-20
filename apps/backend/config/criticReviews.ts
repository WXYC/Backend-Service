/**
 * Configuration for external critic-review snippets on the album-metadata
 * serve path (album-critic-reviews slice, ADR 0012).
 *
 * When enabled, `GET /proxy/metadata/album` does one extra indexed read
 * against `album_critic_reviews` (keyed on the same `library.id` the handler
 * already resolves) and attaches a non-empty `criticReviews` array to the
 * response. The flag is strict-`true` gated so an accidental
 * `CRITIC_REVIEWS_ENABLED=1` does not silently add a query to a hot path.
 *
 * Defaults to `false` so production behavior — response shape and serve-path
 * query plan — is byte-for-byte unchanged until an operator opts in. This
 * keeps the change compatible with the Post-launch service hardening freeze
 * (project #32) on the album-metadata serve path: no added latency ships to
 * prod until the flag is flipped, at which point the read's cost can be
 * measured against #32's perf budgets deliberately. See ADR 0012.
 */

export interface CriticReviewsConfig {
  enabled: boolean;
}

export function loadConfig(): CriticReviewsConfig {
  return {
    enabled: process.env.CRITIC_REVIEWS_ENABLED === 'true',
  };
}

let _config: CriticReviewsConfig | null = null;

export function getConfig(): CriticReviewsConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset the cached singleton. Tests that mutate
 * `process.env.CRITIC_REVIEWS_ENABLED` between cases must call this in
 * `beforeEach` so the next `getConfig()` re-reads the environment.
 */
export function resetConfig(): void {
  _config = null;
}
