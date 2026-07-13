/**
 * Concurrency + rate-limit gate for jobs/concerts-artist-lml-resolver (BS#1614).
 *
 * Mirrors jobs/rotation-release-id-backfill/lml-limiter.ts with job-scoped
 * env names (CONCERTS_ARTIST_RESOLVE_*) and the same stricter-than-runtime
 * defaults (concurrency=1, rate=20/min). The 2026-05-21 incident (BS#994)
 * is the safety story this limiter exists to defend; copying the file keeps
 * this job's blast-radius story identical to the other cron jobs', without
 * coupling any of them to another's build graph.
 *
 * Rate accounting note: `resolveArtistNamesBulk` takes ONE token per BATCH
 * (LML paces its own serial Discogs fan-out inside the request), and the
 * job sends pages serially, so concurrency never exceeds 1 in practice —
 * the token bucket only prevents hot-looping through cheap identity_store
 * pages faster than 20 pages/min.
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
    maxConcurrent: config?.maxConcurrent ?? envInt('CONCERTS_ARTIST_RESOLVE_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('CONCERTS_ARTIST_RESOLVE_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton consumed by job.ts. Reads CONCERTS_ARTIST_RESOLVE_*
 * from env at module load — mutating process.env after the first import of
 * this module does NOT reconfigure the singleton. Tests that exercise
 * different limits must call `createLmlLimiter()` directly with explicit
 * config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
