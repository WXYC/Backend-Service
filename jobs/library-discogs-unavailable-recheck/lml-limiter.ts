/**
 * Concurrency + rate-limit gate for jobs/library-discogs-unavailable-recheck
 * (BS#1283).
 *
 * Mirrors jobs/rotation-release-id-backfill/lml-limiter.ts with job-scoped
 * env names (LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_*) and the same
 * stricter-than-runtime defaults (concurrency=1, rate=20/min). Copying the
 * file keeps this job's blast-radius story identical to the other cron
 * jobs' without coupling any of them to another's build graph. Per the
 * BS#1826 policy layer (`shared/lml-client/src/policy.ts`), this job's
 * registered caller (`library-discogs-unavailable-recheck`) is class 5
 * (batch/backfill enrichment) — class 5 callers use a dedicated per-job
 * limiter, never the shared `defaultLimiter`.
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
    maxConcurrent: config?.maxConcurrent ?? envInt('LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton consumed by lml-fetch.ts. Reads
 * LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_* from env at module load — mutating
 * process.env after the first import of this module does NOT reconfigure the
 * singleton. Tests that exercise different limits must call
 * `createLmlLimiter()` directly with explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
