/**
 * Configuration for external critic-review snippets on the album-metadata
 * serve path (album-critic-reviews slice, ADR 0012).
 *
 * When enabled, `GET /proxy/metadata/album` does one extra indexed read
 * against `album_critic_reviews` (keyed on the same `library.id` the handler
 * already resolves for the metadata read — a shared resolve, not a second key
 * lookup) and attaches a non-empty `criticReviews` array to the response. The
 * flag is strict-`true` gated so an accidental `CRITIC_REVIEWS_ENABLED=1` does
 * not silently add a query to a hot path.
 *
 * Defaults to `false` so production behavior — response shape and serve-path
 * query plan — is byte-for-byte unchanged until an operator opts in. This
 * keeps the change compatible with the Post-launch service hardening freeze
 * (project #32) on the album-metadata serve path: no added latency ships to
 * prod until the flag is flipped, at which point the read's cost can be
 * measured against #32's perf budgets deliberately. See ADR 0012.
 *
 * The singleton mechanics (strict-`true` parse, lazy cache, `resetConfig` test
 * hook) come from the shared {@link createEnvFlagConfig} factory. Tests that
 * mutate `process.env.CRITIC_REVIEWS_ENABLED` between cases must call
 * `resetConfig()` in `beforeEach` so the next `getConfig()` re-reads the env.
 */
import { createEnvFlagConfig, type EnvFlagConfig } from './envFlag.js';

export type CriticReviewsConfig = EnvFlagConfig;

export const { loadConfig, getConfig, resetConfig } = createEnvFlagConfig('CRITIC_REVIEWS_ENABLED');
