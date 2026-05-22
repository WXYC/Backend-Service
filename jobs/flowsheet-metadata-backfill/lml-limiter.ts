/**
 * Concurrency + rate-limit gate for the flowsheet-metadata-backfill cron's
 * LML calls (BS#995, sub-issue of BS#994).
 *
 * Wraps `@wxyc/lml-client`'s shared `createLmlLimiter` factory with the
 * backfill's stricter env-var defaults:
 *
 *   - BACKFILL_LML_MAX_CONCURRENT = 1  (vs runtime LML_CLIENT_MAX_CONCURRENT=5)
 *   - BACKFILL_LML_RATE_PER_MIN   = 20 (vs runtime LML_CLIENT_RATE_PER_MIN=50)
 *
 * The 2026-05-21 incident (BS#994) showed that the orchestrator's serial
 * loop alone isn't a sufficient safety story: one in-flight LML call held
 * for the full 30s catch-arm budget already saturated LML's Discogs
 * fan-out, head-of-line-blocking real-time iOS + dj-site traffic. The
 * token bucket caps backfill's burst rate independent of the orchestrator's
 * speed; the semaphore is belt-and-suspenders defense if the orchestrator
 * ever becomes concurrent.
 *
 * Primitives (`Semaphore`, `TokenBucket`, `LmlLimiter`, `createLmlLimiter`)
 * live in `@wxyc/lml-client` post-BS#887 and are re-exported here so the
 * backfill's existing tests + callsites keep their import path. The
 * `defaultLmlLimiter` singleton is the backfill's instance — wired with
 * BACKFILL_LML_* env defaults — and is passed to
 * `@wxyc/lml-client.lookupMetadata({..., limiter})` from `lml-fetch.ts`.
 */

import { type LmlLimiter, Semaphore, TokenBucket, createLmlLimiter as createSharedLmlLimiter } from '@wxyc/lml-client';

export { type LmlLimiter, Semaphore, TokenBucket };

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Number(raw) (not parseInt) so partial-parse strings like "20banana"
  // surface as NaN and get rejected, instead of silently coercing to 20.
  // Matches the contract in `@wxyc/lml-client`.
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // Surface misconfigurations at startup so an operator who set `=0`
  // intending to disable the limiter sees their value was rejected
  // instead of silently falling back. A 0-permit semaphore would
  // deadlock, which is why we don't accept it.
  console.warn(`lml-limiter: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

/**
 * Wraps `@wxyc/lml-client.createLmlLimiter` so callers can omit config and
 * get the backfill's stricter BACKFILL_LML_* env-var defaults. Pass explicit
 * config in tests; in production the singleton at the bottom of this file
 * reads from env vars.
 */
export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter =>
  createSharedLmlLimiter({
    maxConcurrent: config?.maxConcurrent ?? envInt('BACKFILL_LML_MAX_CONCURRENT', 1),
    ratePerMinute: config?.ratePerMinute ?? envInt('BACKFILL_LML_RATE_PER_MIN', 20),
  });

/**
 * Module-level singleton used by `lml-fetch.ts`. Reads BACKFILL_LML_* from
 * env at module load — mutating `process.env` after the first import of
 * this module does NOT reconfigure the singleton. Tests that need to
 * exercise different limits or env values must call `createLmlLimiter()`
 * directly with explicit config.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
