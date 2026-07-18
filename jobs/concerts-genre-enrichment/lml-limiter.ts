/**
 * Concurrency + rate-limit gate for jobs/concerts-genre-enrichment (BS#1624).
 *
 * Mirrors jobs/concerts-artist-lml-resolver/lml-limiter.ts with job-scoped
 * env names (CONCERTS_GENRE_ENRICH_*) and the same stricter-than-runtime
 * defaults (concurrency=1, rate=20/min). Copying the file keeps this job's
 * blast-radius story identical to the other cron jobs' without coupling any of
 * them to another's build graph.
 *
 * Rate accounting note: `fetchArtistGenresBulk` takes ONE token per BATCH (LML
 * paces its own fan-out inside the request), and the job sends pages serially,
 * so concurrency never exceeds 1 in practice — the token bucket only prevents
 * hot-looping through cheap pages faster than 20 pages/min.
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
    maxConcurrent: config?.maxConcurrent ?? envInt('CONCERTS_GENRE_ENRICH_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('CONCERTS_GENRE_ENRICH_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton consumed by job.ts. Reads CONCERTS_GENRE_ENRICH_*
 * from env at module load — mutating process.env after the first import of
 * this module does NOT reconfigure the singleton. Tests that exercise
 * different limits must call `createLmlLimiter()` directly with explicit
 * config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
