/**
 * Concurrency + rate-limit gate for jobs/library-artwork-url-backfill
 * (BS#1911).
 *
 * Mirrors jobs/library-canonical-entity-backfill/lml-limiter.ts with
 * job-scoped env names (LIBRARY_ARTWORK_URL_BACKFILL_*). Per the BS#1826
 * policy layer (`shared/lml-client/src/policy.ts`), this job's registered
 * caller (`library-artwork-url-backfill`) is class 5 (batch/backfill
 * enrichment) — the class-5 convention there is explicit that the caller
 * MUST supply its own dedicated limiter, never the shared process-wide
 * `defaultLimiter`.
 *
 * Rate defaults to 50/min — matching the shared `defaultLimiter` rate this
 * job has always ridden, not the sibling jobs' conservative 20/min, so
 * dedicating the limiter doesn't change this job's long-standing sweep
 * pacing.
 * Concurrency defaults to 1 to match `orchestrate.ts`'s strictly-sequential
 * loop (one in-flight LML request at a time) — raising it here without also
 * changing the orchestrator's loop shape would just queue extra permits
 * nothing will ever claim. What the dedicated limiter drops relative to
 * `defaultLimiter` — the circuit breaker and the bounded queue wait — is
 * inert-to-benign for a strictly-sequential job: nothing ever queues, and
 * during an LML outage each row now surfaces as a per-row timeout error
 * that forward-rolls to the next sweep, instead of a 30s breaker-shed
 * window that resolved to an empty response — both outcomes leave the row
 * unstamped and retryable.
 *
 * The underlying primitives (Semaphore, TokenBucket, LmlLimiter,
 * createLmlLimiter) live in @wxyc/lml-client post-BS#887.
 */

import {
  type LmlLimiter,
  Semaphore,
  TokenBucket,
  createLmlLimiter as createSharedLmlLimiter,
  envInt,
} from '@wxyc/lml-client';

export { type LmlLimiter, Semaphore, TokenBucket };

// `envInt` is imported from `@wxyc/lml-client` (not redefined locally) so a
// future tightening of env validation (e.g. reject fractional values, add
// an upper bound) lives in one place across every BS workload that talks to
// LML.

export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter =>
  createSharedLmlLimiter({
    maxConcurrent: config?.maxConcurrent ?? envInt('LIBRARY_ARTWORK_URL_BACKFILL_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('LIBRARY_ARTWORK_URL_BACKFILL_RATE_PER_MIN', 50),
  });

/**
 * Module-level singleton consumed by lml-fetch.ts. Reads
 * LIBRARY_ARTWORK_URL_BACKFILL_* from env at module load — mutating
 * process.env after the first import of this module does NOT reconfigure the
 * singleton. Tests that exercise different limits must call
 * `createLmlLimiter()` directly with explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
