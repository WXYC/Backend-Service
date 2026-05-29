/**
 * Concurrency + rate-limit gate for the flowsheet-artwork-repair drain
 * (BS#1209). Same shape as `jobs/flowsheet-metadata-backfill/lml-limiter.ts`
 * (BS#995) — reuses the shared `@wxyc/lml-client` primitives so this drain
 * doesn't bypass the chokepoint (BS#1137 antipattern).
 *
 * Env defaults mirror flowsheet-metadata-backfill:
 *
 *   - BACKFILL_LML_MAX_CONCURRENT = 1
 *   - BACKFILL_LML_RATE_PER_MIN   = 20
 *
 * Why share the env vars with the sibling drain: when both jobs run
 * concurrently, the shared env var caps total combined pace at the
 * configured ceiling — exactly the cooperative throttling that the BS#994
 * monopolization incident demanded. If we forked the env vars, an operator
 * raising BACKFILL_LML_RATE_PER_MIN to speed up the historical drain would
 * NOT affect this job, and the combined throughput could saturate LML.
 *
 * The 2026-05-21 incident (BS#994) showed that the orchestrator's serial
 * loop alone isn't sufficient: one in-flight LML call held for the full
 * 30 s catch-arm budget already saturated LML's Discogs fan-out. The token
 * bucket caps burst rate independent of the orchestrator's speed; the
 * semaphore is belt-and-suspenders defense if a future orchestrator change
 * makes the loop concurrent.
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
