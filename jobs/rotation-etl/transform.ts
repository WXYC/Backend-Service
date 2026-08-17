/**
 * Data transformers for the rotation ETL.
 *
 * Maps tubafrenzy rotation release data to Backend-Service schema.
 * All functions are pure (no side effects) for easy testing.
 */

import { epochMsToDate } from '@wxyc/database';

/**
 * Classify a tubafrenzy ROTATION_TYPE. Re-exported from `@wxyc/database` so
 * this job, the rotation webhook, and `POST /library/rotation` share one
 * normalization rule.
 *
 * BS#2173: this used to fall back to `'N'` for anything unrecognized, which is
 * not a rotation bin — see `freqEnum` in shared/database/src/schema.ts. It also
 * collapsed blank and unrecognized into one outcome, which silently swallowed
 * genuine bad data under a "no bin upstream" log line. The caller now tells
 * them apart.
 */
export { parseRotationBin } from '@wxyc/database';

/**
 * Convert an epoch milliseconds value to a YYYY-MM-DD date string.
 * Returns null for 0 (tubafrenzy uses 0 for "not set") or invalid values.
 */
export const epochMsToDateString = (epochMs: number): string | null => {
  const date = epochMsToDate(epochMs);
  if (!date) return null;
  return date.toISOString().split('T')[0];
};
