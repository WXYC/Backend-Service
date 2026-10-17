/**
 * Who the review screens are open to (BS#3385, mirroring B2's `REVIEWS_AUDIENCE`, BS#3358). Backend-Service learns it
 * from `REVIEWS_AUDIENCE`, set to the same value as the DJ site's `NEXT_PUBLIC_REVIEWS_ENABLED` and read with its
 * spellings: `staff` is staff, `true` or `1` is everyone, and anything else (unset, empty, `TRUE`, `yes`) is off. It ships
 * off. It does not use {@link createEnvFlagConfig}, which reads only a strict `true`, but keeps that module's shape: a
 * lazy cache, `loadConfig` reading fresh, and `resetConfig` for tests that change the env var.
 */
export type ReviewsAudience = 'off' | 'staff' | 'everyone';

export interface ReviewsAudienceConfig {
  audience: ReviewsAudience;
}

let cached: ReviewsAudienceConfig | null = null;

export function loadConfig(): ReviewsAudienceConfig {
  const raw = process.env.REVIEWS_AUDIENCE;
  if (raw === 'staff') {
    return { audience: 'staff' };
  }
  return { audience: raw === 'true' || raw === '1' ? 'everyone' : 'off' };
}

export function getConfig(): ReviewsAudienceConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfig(): void {
  cached = null;
}
