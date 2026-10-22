import type { FeatureAudience } from '@wxyc/shared/dtos';
import { resetFeatureAccess } from '../../apps/backend/config/featureAccess';

/** `REVIEWS_AUDIENCE` spells `everyone` as `true`; `off` may also be left unset. */
const ENV_SPELLING = { off: 'off', staff: 'staff', everyone: 'true' } as const;

const ENV_KEYS = ['REVIEWS_AUDIENCE', 'POSTHOG_FLAGS_API_KEY', 'POSTHOG_SECRET_KEY'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/**
 * Open the `reviews` feature to `audience` through the env fallback, with the PostHog flag client off, and drop the
 * seam's cached reads. `undefined` leaves `REVIEWS_AUDIENCE` unset, which reads as `off`.
 */
export const givenAudience = (audience: FeatureAudience | undefined): void => {
  delete process.env.POSTHOG_FLAGS_API_KEY;
  delete process.env.POSTHOG_SECRET_KEY;
  if (audience === undefined) {
    delete process.env.REVIEWS_AUDIENCE;
  } else {
    process.env.REVIEWS_AUDIENCE = ENV_SPELLING[audience];
  }
  resetFeatureAccess();
};

/** For `afterAll`: put the env back as the file found it. */
export const restoreAudience = (): void => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  resetFeatureAccess();
};

/**
 * The access rule for `reviews`, written out on its own so it stays independent of `accessAt` and `canAccess` (epic
 * BS#3528, decision 15): `off` is nobody; `staff` is music directors and above, or an account holding `reviews_beta`;
 * `everyone` is every DJ. An account below DJ never has access.
 */
export const expectedReviewsAccess = (
  audience: FeatureAudience,
  { role, capabilities }: { role: string | undefined; capabilities: string[] }
): boolean => {
  const isDj = role === 'dj' || role === 'musicDirector' || role === 'stationManager';
  const isStaff = role === 'musicDirector' || role === 'stationManager';
  if (!isDj || audience === 'off') {
    return false;
  }
  return audience === 'everyone' || isStaff || capabilities.includes('reviews_beta');
};

const AUDIENCES: FeatureAudience[] = ['off', 'staff', 'everyone'];
const ROLES = ['member', 'dj', 'musicDirector', 'stationManager'];
const CAPABILITIES: string[][] = [[], ['reviews_beta'], ['editor']];

/** Every audience x role x capabilities combination with its expected access, shaped for `test.each`. */
export const ACCESS_CASES: [FeatureAudience, string, string[], boolean][] = AUDIENCES.flatMap((audience) =>
  ROLES.flatMap((role) =>
    CAPABILITIES.map((capabilities): [FeatureAudience, string, string[], boolean] => [
      audience,
      role,
      capabilities,
      expectedReviewsAccess(audience, { role, capabilities }),
    ])
  )
);
