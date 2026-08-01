/**
 * Concurrency + rate-limit gate for jobs/library-canonical-entity-backfill
 * (B-1.2 / BS#1911 review).
 *
 * Mirrors jobs/library-discogs-unavailable-recheck/lml-limiter.ts with
 * job-scoped env names (LIBRARY_CANONICAL_ENTITY_BACKFILL_*). Per the
 * BS#1826 policy layer (`shared/lml-client/src/policy.ts`), this job's
 * registered caller (`library-canonical-entity-backfill`) is class 5
 * (batch/backfill enrichment) — the class-5 convention there is explicit
 * that the caller MUST supply its own dedicated limiter, never the shared
 * process-wide `defaultLimiter`. BS#1911 landed the class-5 caller label but
 * left this job riding `defaultLimiter`; this file (and lml-fetch.ts's
 * threading of it) closes that gap.
 *
 * Rate defaults to 50/min — deliberately NOT the sibling jobs'
 * conservative 20/min. This job drains the live `library.canonical_entity_id`
 * retry pool (~34,520 rows on prod as of the 2026-07-31 measurement in
 * lml-fetch.ts's docstring); a full sweep at 20/min is ~29h versus ~11.5h
 * at 50/min, and the probe documented in lml-fetch.ts's docstring found no
 * evidence that the extra throughput trades away recall.
 * Concurrency defaults to 1 to match `orchestrate.ts`'s strictly-sequential
 * loop (`THROTTLE_MS=100`, one in-flight LML request at a time) — raising
 * it here without also changing the orchestrator's loop shape would just
 * queue extra permits nothing will ever claim.
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
    maxConcurrent: config?.maxConcurrent ?? envInt('LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN', 50),
  });

/**
 * Module-level singleton consumed by lml-fetch.ts. Reads
 * LIBRARY_CANONICAL_ENTITY_BACKFILL_* from env at module load — mutating
 * process.env after the first import of this module does NOT reconfigure the
 * singleton. Tests that exercise different limits must call
 * `createLmlLimiter()` directly with explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
