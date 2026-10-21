/**
 * Who the review screens are open to (BS#3385, mirroring B2's `REVIEWS_AUDIENCE`, BS#3358). Backend-Service learns it
 * from `REVIEWS_AUDIENCE`, set to the same value as the DJ site's `NEXT_PUBLIC_REVIEWS_ENABLED` and read with its
 * spellings: `staff` is staff, `true` or `1` is everyone, and anything else (unset, empty, `TRUE`, `yes`) is off. It ships
 * off. It does not use {@link createEnvFlagConfig}, which reads only a strict `true`. Since BS#3529 the audience is
 * read through `config/featureAccess.ts` (PostHog flag first, this env var as the fallback, read fresh), and this file
 * holds only the type and `parseAudience`.
 */
export type ReviewsAudience = 'off' | 'staff' | 'everyone';

/** The spellings above, for any raw value: the feature-access seam's env fallback (`config/featureAccess.ts`) reads through this. */
export function parseAudience(raw: string | undefined): ReviewsAudience {
  if (raw === 'staff') {
    return 'staff';
  }
  return raw === 'true' || raw === '1' ? 'everyone' : 'off';
}
