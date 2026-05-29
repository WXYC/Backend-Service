/**
 * BACKFILL_LML_* env vars are shared with `flowsheet-metadata-backfill` —
 * an operator tightening one job's limit tightens both. Diverging the
 * names would let a "speed up the other drain" change silently saturate
 * LML when both jobs run concurrently (BS#994 monopolization pattern).
 *
 * The token bucket bounds burst rate independent of the orchestrator's
 * loop shape; the semaphore is belt-and-suspenders defense if a future
 * change makes the loop concurrent.
 */

import { type LmlLimiter, Semaphore, TokenBucket, createLmlLimiter as createSharedLmlLimiter } from '@wxyc/lml-client';

export { type LmlLimiter, Semaphore, TokenBucket };

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-limiter: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter =>
  createSharedLmlLimiter({
    maxConcurrent: config?.maxConcurrent ?? envInt('BACKFILL_LML_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('BACKFILL_LML_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton used by `lml-fetch.ts`. Env vars are read at module
 * load — mutating `process.env` after import does not reconfigure the
 * singleton. Tests pass explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
