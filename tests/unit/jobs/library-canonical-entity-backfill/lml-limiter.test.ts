// Unit tests for jobs/library-canonical-entity-backfill's rate-limit gate
// (B-1.2 / BS#1911 review). Mirrors
// tests/unit/jobs/flowsheet-metadata-backfill/lml-limiter.test.ts with
// job-scoped env names (LIBRARY_CANONICAL_ENTITY_BACKFILL_*) and this job's
// own defaults (1 permit, 50/min).

import {
  Semaphore,
  TokenBucket,
  createLmlLimiter,
} from '../../../../jobs/library-canonical-entity-backfill/lml-limiter';

describe('jobs/library-canonical-entity-backfill/lml-limiter (B-1.2 / BS#1911 review)', () => {
  describe('Semaphore', () => {
    it('grants permits up to capacity without blocking', async () => {
      const sem = new Semaphore(2);
      await sem.acquire();
      await sem.acquire();
      expect(sem.availablePermits).toBe(0);
      expect(sem.queueDepth).toBe(0);
    });

    it('blocks acquire past capacity until release wakes the waiter', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      let resolved = false;
      const second = sem.acquire().then(() => {
        resolved = true;
      });

      // Yield to the event loop; the second acquire should still be queued.
      await new Promise((r) => setImmediate(r));
      expect(resolved).toBe(false);
      expect(sem.queueDepth).toBe(1);

      sem.release();
      await second;
      expect(resolved).toBe(true);
      expect(sem.queueDepth).toBe(0);
    });

    it('release without waiters does not exceed capacity', () => {
      const sem = new Semaphore(2);
      // Both permits available; a stray release must not bump us to 3.
      sem.release();
      expect(sem.availablePermits).toBe(2);
    });

    it('wakes waiters in FIFO order', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const order: number[] = [];
      const w1 = sem.acquire().then(() => order.push(1));
      const w2 = sem.acquire().then(() => order.push(2));

      sem.release();
      await w1;
      expect(order).toEqual([1]);

      sem.release();
      await w2;
      expect(order).toEqual([1, 2]);
    });
  });

  describe('TokenBucket', () => {
    it('starts at capacity and consumes synchronously when tokens are available', async () => {
      const bucket = new TokenBucket({ capacity: 3, refillPerMinute: 60 });
      // Allow for tiny refill drift since construction; capacity-bounded.
      expect(bucket.availableTokens).toBeGreaterThanOrEqual(2.99);
      expect(bucket.availableTokens).toBeLessThanOrEqual(3);

      await bucket.consume(1);
      await bucket.consume(1);
      await bucket.consume(1);
      // Bucket is now ~empty (minus tiny refill earned during the awaits).
      expect(bucket.availableTokens).toBeLessThan(0.5);
    });

    it('blocks consume when empty and resolves after enough refill', async () => {
      // 6000/min = 100 tokens/sec = 10ms per token. After consuming the
      // initial token, the next consume should block for ~10ms before
      // enough has refilled.
      const bucket = new TokenBucket({ capacity: 1, refillPerMinute: 6000 });
      await bucket.consume(1); // drain.

      const start = Date.now();
      await bucket.consume(1);
      const elapsed = Date.now() - start;

      // Allow generous slack for CI jitter on either side.
      expect(elapsed).toBeGreaterThanOrEqual(5);
      expect(elapsed).toBeLessThan(200);
    });

    it('refill is capped at capacity (no burst beyond configured ceiling)', async () => {
      const bucket = new TokenBucket({ capacity: 2, refillPerMinute: 6000 });
      // Drain.
      await bucket.consume(2);
      // Wait long enough that, without the cap, we'd have refilled past 2.
      await new Promise((r) => setTimeout(r, 100)); // 100ms × 100 tps = 10 tokens of "potential" refill
      // Cap pegs us at capacity = 2.
      expect(bucket.availableTokens).toBeLessThanOrEqual(2);
      expect(bucket.availableTokens).toBeGreaterThanOrEqual(1.9);
    });
  });

  describe('createLmlLimiter', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('uses defaults (1 permit, 50/min) when env vars are unset', () => {
      process.env = { ...originalEnv };
      delete process.env.LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT;
      delete process.env.LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN;

      const limiter = createLmlLimiter();
      const s = limiter.state();
      expect(s.availablePermits).toBe(1);
      // Capacity = 50; allow for tiny refill drift.
      expect(s.availableTokens).toBeGreaterThanOrEqual(49.9);
      expect(s.availableTokens).toBeLessThanOrEqual(50);
    });

    it('reads LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT and LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN from env', () => {
      process.env = {
        ...originalEnv,
        LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT: '3',
        LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN: '120',
      };

      const limiter = createLmlLimiter();
      const s = limiter.state();
      expect(s.availablePermits).toBe(3);
      expect(s.availableTokens).toBeGreaterThanOrEqual(119.9);
    });

    it('falls back to default on non-positive or unparseable env values, with a warn', () => {
      process.env = {
        ...originalEnv,
        LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT: '0',
        LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN: 'banana',
      };
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const limiter = createLmlLimiter();
      expect(limiter.state().availablePermits).toBe(1);
      expect(limiter.state().availableTokens).toBeGreaterThanOrEqual(49.9);
      // Surface misconfigurations: both bad values must warn. `envInt` is
      // the shared @wxyc/lml-client implementation post-Fix-4a (its warn
      // prefix is "lml.client:", not the job-local "lml-limiter:" the
      // flowsheet-metadata-backfill sibling used) — match on the env var
      // name/value only, not the prefix, so this doesn't pin an
      // implementation detail owned by the shared client.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT=0'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN=banana')
      );

      warn.mockRestore();
    });

    it('rejects partial-parse strings like "20banana" (no silent coercion)', () => {
      process.env = { ...originalEnv, LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT: '20banana' };
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const limiter = createLmlLimiter();
      // 20banana → NaN under Number(), not 20 under parseInt; falls back.
      expect(limiter.state().availablePermits).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT=20banana')
      );

      warn.mockRestore();
    });

    it('explicit config overrides env vars', () => {
      process.env = {
        ...originalEnv,
        LIBRARY_CANONICAL_ENTITY_BACKFILL_MAX_CONCURRENT: '999',
        LIBRARY_CANONICAL_ENTITY_BACKFILL_RATE_PER_MIN: '999',
      };

      const limiter = createLmlLimiter({ maxConcurrent: 2, ratePerMinute: 30 });
      expect(limiter.state().availablePermits).toBe(2);
      expect(limiter.state().availableTokens).toBeGreaterThanOrEqual(29.9);
    });

    it('serializes concurrent run() calls on the semaphore (FIFO)', async () => {
      // High rate so token bucket never blocks; only the semaphore can.
      const limiter = createLmlLimiter({ maxConcurrent: 1, ratePerMinute: 60_000 });

      const order: number[] = [];
      const work = (n: number) => async () => {
        order.push(n);
        // Yield twice to let any concurrency interleave if it could.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        order.push(-n);
      };

      await Promise.all([limiter.run(work(1)), limiter.run(work(2)), limiter.run(work(3))]);

      // Each call must complete (push -n) before the next starts.
      expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    });

    it('releases the permit even when the callback throws', async () => {
      const limiter = createLmlLimiter({ maxConcurrent: 1, ratePerMinute: 60_000 });

      await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

      // Permit returned; next call must proceed without blocking.
      expect(limiter.state().availablePermits).toBe(1);
      expect(limiter.state().queueDepth).toBe(0);
      await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it('does not refund the token on error (limits attempted, not successful, rate)', async () => {
      const limiter = createLmlLimiter({ maxConcurrent: 5, ratePerMinute: 60 });
      const tokensBefore = limiter.state().availableTokens;

      await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

      const tokensAfter = limiter.state().availableTokens;
      // One token consumed despite the failure. Allow tiny refill drift.
      expect(tokensBefore - tokensAfter).toBeGreaterThanOrEqual(0.95);
      expect(tokensBefore - tokensAfter).toBeLessThanOrEqual(1.1);
    });
  });
});
