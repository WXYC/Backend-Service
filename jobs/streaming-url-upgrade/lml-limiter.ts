/**
 * Concurrency + rate-limit gate for streaming-url-upgrade's LML calls.
 *
 * Mirrors jobs/apple-music-url-backfill/lml-limiter.ts: same Sem(1) +
 * TB(20/min) envelope so a one-shot drain shares LML's 50/min Discogs budget
 * gently with real-time traffic. The 2026-05-21 incident (BS#994)
 * established that a serial loop alone is insufficient — the token bucket
 * caps burst rate independent of orchestrator speed.
 *
 * Reads UPGRADE_LML_* env vars — a distinct knob from the BACKFILL_LML_*
 * family so this job's rate can be tuned without touching the apple backfill.
 * The LML/Discogs budget is still shared, so the pre-flight is the same:
 * verify no sibling backfill/cron container is running before executing.
 */

import { type LmlLimiter, Semaphore, TokenBucket, createLmlLimiter as createSharedLmlLimiter } from '@wxyc/lml-client';
import { envInt } from './env.js';

export { type LmlLimiter, Semaphore, TokenBucket };

export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter =>
  createSharedLmlLimiter({
    maxConcurrent: config?.maxConcurrent ?? envInt('UPGRADE_LML_MAX_CONCURRENT', 1, 'lml-limiter'),
    ratePerMinute: config?.ratePerMinute ?? envInt('UPGRADE_LML_RATE_PER_MIN', 20, 'lml-limiter'),
  });

export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
