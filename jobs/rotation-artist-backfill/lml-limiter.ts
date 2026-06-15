/**
 * Concurrency + rate-limit gate for jobs/rotation-artist-backfill (BS#1381).
 *
 * One LML call here is a **batch** of up to 50 identity_ids; LML expands
 * each batch internally to its per-source (release + walk-to-artists) fan-out
 * (~50 release + ~150 artist Discogs calls on a cold-cache 50-id batch).
 * This is a fundamentally different shape from the per-Discogs-call rate
 * math the BS#1361 iteration was sized against. The limiter here gates the
 * number of *batches in flight* against LML, NOT the Discogs egress rate
 * (LML's own per-replica `discogs_max_concurrent=5` semaphore +
 * `discogs_rate_limit=50/min` AsyncLimiter does that, and is the binding
 * ceiling on cold-cache days).
 *
 * Defaults (concurrency=3, ratePerMinute=20):
 *   - These were inherited from the BS#1361 per-Discogs-call shape and
 *     are now operationally over-provisioned against batch-call semantics.
 *     A 50-id batch arriving at LML can stack ~200 Discogs calls behind
 *     its 50/min internal cap (~4 min cold-cache wall-clock per batch);
 *     bursting 3 concurrent batches at 20/min stuffs LML's queue without
 *     speeding the run — LML's Discogs limiter is the binding ceiling.
 *     They are kept for backwards compatibility and to avoid a silent
 *     runtime shift during the review pass; pre-merge load-testing
 *     (README "Pre-merge load-test methodology") is responsible for
 *     dialing operationally correct values before this default is touched.
 *   - The token bucket counts attempted batches, not successful ones —
 *     failed calls still consume a token, mirroring the sibling backfill
 *     jobs so blast-radius math stays consistent.
 *
 * Override via `BACKFILL_LML_MAX_CONCURRENT` / `BACKFILL_LML_RATE_PER_MIN`
 * so ops can dial these down without a redeploy if foreground traffic
 * patterns change. README contains the load-test methodology for adjusting
 * defaults against measured LML+Discogs steady-state.
 *
 * `envInt` is imported from `@wxyc/lml-client` (not redefined locally)
 * so a future tightening of env validation (e.g. reject fractional
 * values, add an upper bound) lives in one place across every BS workload
 * that talks to LML.
 */

import {
  type LmlLimiter,
  Semaphore,
  TokenBucket,
  createLmlLimiter as createSharedLmlLimiter,
  envInt,
} from '@wxyc/lml-client';

export { type LmlLimiter, Semaphore, TokenBucket };

export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter =>
  createSharedLmlLimiter({
    maxConcurrent: config?.maxConcurrent ?? envInt('BACKFILL_LML_MAX_CONCURRENT', 3),
    ratePerMinute: config?.ratePerMinute ?? envInt('BACKFILL_LML_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton consumed by lml-fetch.ts. Reads BACKFILL_LML_*
 * from env at module load — mutation of `process.env` after import does
 * NOT reconfigure this singleton. Tests that exercise different limits
 * must call `createLmlLimiter()` directly with explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
