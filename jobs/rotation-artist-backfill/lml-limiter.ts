/**
 * Concurrency + rate-limit gate for jobs/rotation-artist-backfill (BS#1361).
 *
 * Mirrors the limiter pattern from jobs/rotation-release-id-backfill and
 * jobs/flowsheet-metadata-backfill (BS#995). Defaults to concurrency=3 and
 * rate=20/min — chosen per the issue's rate-limit + concurrency analysis:
 *
 *   - LML caps Discogs egress at 50 req/min globally via its in-process
 *     AsyncLimiter (`discogs/ratelimit.py:33`). 20 req/min from this cron
 *     leaves >30 req/min for foreground LML traffic (DJ flowsheet
 *     lookups, request-o-matic, the synthetic-DJ canary) even during the
 *     run window.
 *   - Concurrency=3 leaves enough parallelism to overlap one Discogs
 *     round-trip's slow tail (5–10 s on cold-cache 429-retry) with the
 *     next two calls' fast path, but is low enough that a brief PG
 *     cool-down on LML's side (30 s, per `discogs/fallthrough.py:81-126`)
 *     can't pile up a 429 cluster against the per-replica limiter.
 *   - The token bucket caps attempted-call rate, NOT successful-call
 *     rate. Failed calls still consume a token — same shape as the
 *     other backfill jobs so blast-radius math stays consistent.
 *
 * Override via `BACKFILL_LML_MAX_CONCURRENT` / `BACKFILL_LML_RATE_PER_MIN`
 * so ops can dial these down without a redeploy if foreground traffic
 * patterns change.
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
    maxConcurrent: config?.maxConcurrent ?? envInt('BACKFILL_LML_MAX_CONCURRENT', 3),
    ratePerMinute: config?.ratePerMinute ?? envInt('BACKFILL_LML_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton consumed by lml-fetch.ts. Reads BACKFILL_LML_* from
 * env at module load — see the matching note on the rotation-release-id
 * backfill's limiter for why mutation of `process.env` after import does
 * NOT reconfigure this singleton.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
