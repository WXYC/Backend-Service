/**
 * Configuration for consented WXYC DJ album reviews on the album-metadata
 * serve path (DJ Google-Form review archive, ADR 0011).
 *
 * When enabled, `GET /proxy/metadata/album` does one extra indexed read
 * against `album_review_submissions` (keyed on the same `library.id` the
 * handler already resolves for the metadata read — a shared resolve, not a
 * second key lookup) and attaches a non-empty `wxycReviews` array to the
 * response.
 *
 * The flag is strict-`true` gated, and here that gate carries more weight
 * than it does for its critic-reviews sibling. `album_critic_reviews` holds
 * published third-party text that was already public; this table holds
 * unpublished reviewer-authored bodies whose publication rests entirely on
 * an opt-in the reviewer gave on a Google Form. An accidental
 * `WXYC_REVIEWS_ENABLED=1` must therefore not merely avoid adding a query to
 * a hot path — it must not begin publishing at all. Only the literal string
 * `true` enables it.
 *
 * Note that the flag is the *deployment* gate, never the *consent* gate. Row
 * eligibility is decided in SQL by `lookupWxycReviewsByAlbumId`
 * (`social_consent = true`), and that predicate holds whether this flag is
 * on or off. Flipping this flag on can only widen the audience for rows that
 * already cleared consent; it can never promote a non-consented row.
 *
 * Defaults to `false` so production behavior — response shape and serve-path
 * query plan — is byte-for-byte unchanged until an operator opts in. This
 * keeps the change compatible with the Post-launch service hardening freeze
 * (project #32) on the album-metadata serve path: no added latency ships to
 * prod until the flag is flipped, at which point the read's cost can be
 * measured against #32's perf budgets deliberately. See ADR 0011.
 *
 * The singleton mechanics (strict-`true` parse, lazy cache, `resetConfig` test
 * hook) come from the shared {@link createEnvFlagConfig} factory. Tests that
 * mutate `process.env.WXYC_REVIEWS_ENABLED` between cases must call
 * `resetConfig()` in `beforeEach` so the next `getConfig()` re-reads the env.
 */
import { createEnvFlagConfig, type EnvFlagConfig } from './envFlag.js';

export type WxycReviewsConfig = EnvFlagConfig;

export const { loadConfig, getConfig, resetConfig } = createEnvFlagConfig('WXYC_REVIEWS_ENABLED');
