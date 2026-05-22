/**
 * Concurrency + rate-limit gate for the flowsheet-metadata-backfill cron's
 * LML calls (BS#995, sub-issue of BS#994).
 *
 * Layered Semaphore + TokenBucket, mirroring the runtime path's pattern from
 * `apps/backend/services/lml/lml.client.ts` but with stricter defaults
 * tuned for backfill traffic:
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
 * This is the floor of the BS#995 design. The adaptive ceiling (LML-health
 * circuit-breaker pausing the cron when LML p95 is elevated) needs an
 * LML-side health endpoint and lands separately.
 *
 * Duplicated from `apps/backend/services/lml/lml.client.ts` rather than
 * imported because that file pulls in app-only modules (Sentry instance,
 * posthog, etc.) — coupling the one-shot job's build graph to those would
 * force the container to ship the full backend tree. Same reasoning as the
 * `lml-fetch.ts` header.
 */

const envInt = (name: string, defaultValue: number): number => {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
};

/**
 * FIFO permit semaphore. acquire() resolves when a permit is available;
 * release() returns the permit to the next waiter (or restores it if no one
 * is waiting). queueDepth/availablePermits are read-only for observability.
 */
export class Semaphore {
  private permits: number;
  private readonly capacity: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
    this.capacity = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else if (this.permits < this.capacity) {
      this.permits += 1;
    }
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  get availablePermits(): number {
    return this.permits;
  }
}

/**
 * Continuous-refill token bucket. consume(n) resolves once n tokens have
 * been earned; until then the call sleeps for the shortest interval that
 * could earn the deficit.
 */
export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor({ capacity, refillPerMinute }: { capacity: number; refillPerMinute: number }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  async consume(count = 1): Promise<void> {
    // Loop the slow path. Without it, N callers can each compute the same
    // waitMs from an empty bucket, sleep for the same interval, wake
    // together, and all subtract `count` from the freshly refilled tokens
    // — overshooting the configured rate by ~N×. The loop re-checks the
    // bucket after each sleep so only the caller that finds enough tokens
    // proceeds; the others sleep again. Paired with the upstream FIFO
    // Semaphore, this preserves the configured rate under contention.
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const deficit = count - this.tokens;
      const waitMs = Math.max(1, Math.ceil(deficit / this.refillPerMs));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

export interface LmlLimiter {
  /** Acquire a permit + a token, run fn, release the permit in finally. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Snapshot for tests + future observability hooks. */
  state(): { queueDepth: number; availablePermits: number; availableTokens: number };
}

/**
 * Compose a Semaphore + TokenBucket into a single `run`-style gate. Tokens
 * are consumed inside the permit (so wait time on the bucket also holds a
 * permit) and are NOT refunded on error — limiting attempted-call rate, not
 * successful-call rate. Matches `lml.client.ts:postLookup()`'s pattern.
 *
 * Pass explicit config in tests; in production the singleton at the bottom
 * of this file reads from env vars.
 */
export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter => {
  const maxConcurrent = config?.maxConcurrent ?? envInt('BACKFILL_LML_MAX_CONCURRENT', 1);
  const ratePerMinute = config?.ratePerMinute ?? envInt('BACKFILL_LML_RATE_PER_MIN', 20);
  const semaphore = new Semaphore(maxConcurrent);
  const tokenBucket = new TokenBucket({ capacity: ratePerMinute, refillPerMinute: ratePerMinute });
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await semaphore.acquire();
      try {
        await tokenBucket.consume(1);
        return await fn();
      } finally {
        semaphore.release();
      }
    },
    state() {
      return {
        queueDepth: semaphore.queueDepth,
        availablePermits: semaphore.availablePermits,
        availableTokens: tokenBucket.availableTokens,
      };
    },
  };
};

/**
 * Module-level singleton used by `lml-fetch.ts`. Reads BACKFILL_LML_* from
 * env at module load. Tests that need to exercise different limits should
 * call `createLmlLimiter()` directly.
 */
export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
