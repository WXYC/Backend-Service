/**
 * Concurrency + rate-limit gate for flowsheet-reenrichment's LML calls.
 *
 * Mirrors jobs/flowsheet-metadata-backfill/lml-limiter.ts: same Sem(1) +
 * TB(20/min) envelope so both jobs share LML's 50/min Discogs budget gently
 * with real-time traffic. The 2026-05-21 incident (BS#994) established that
 * a serial loop alone is insufficient — the token bucket caps burst rate
 * independent of orchestrator speed.
 *
 * Reads BACKFILL_LML_* env vars (shared with the sibling cron) so operators
 * can tune both jobs from a single knob. Pre-flight: verify the sibling cron
 * container is Exited before running this job (shared budget).
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

export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
