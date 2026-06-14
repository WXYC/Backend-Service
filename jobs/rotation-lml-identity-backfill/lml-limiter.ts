/**
 * Concurrency + rate-limit gate for jobs/rotation-lml-identity-backfill
 * (BS#1380).
 *
 * Mirrors jobs/rotation-release-id-backfill/lml-limiter.ts verbatim — same
 * `BACKFILL_LML_*` env defaults (concurrency=1, rate=20/min) and the same
 * `defaultLmlLimiter` singleton pattern. The 2026-05-21 incident (BS#994)
 * is the safety story this limiter exists to defend; copying the file
 * keeps the rotation-lml-identity-backfill's blast-radius story identical
 * to the other LML-calling backfills, without coupling either to the
 * other's build graph.
 *
 * The underlying primitives (Semaphore, TokenBucket, LmlLimiter,
 * createLmlLimiter) live in @wxyc/lml-client post-BS#887.
 */

import { type LmlLimiter, Semaphore, TokenBucket, createLmlLimiter as createSharedLmlLimiter } from '@wxyc/lml-client';

export { type LmlLimiter, Semaphore, TokenBucket };

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Number() (not parseInt) so partial-parse strings like "20banana" surface
  // as NaN and get rejected rather than silently coercing.
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
 * Module-level singleton consumed by lml-fetch.ts. Reads BACKFILL_LML_* from
 * env at module load — mutating process.env after the first import of this
 * module does NOT reconfigure the singleton. Tests that exercise different
 * limits must call `createLmlLimiter()` directly with explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
