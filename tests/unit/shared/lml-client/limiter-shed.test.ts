/**
 * Unit tests for the BS#1748 LML-client limiter admission bounds: the
 * deadline-aware `Semaphore.acquire`, the per-limiter `LmlCircuitBreaker`, and
 * the shed → empty-`GatedLookupResponse` conversion on the lookup path.
 *
 * The spec's load-bearing invariants live here:
 *   - a not-admitted caller fast-fails with `LimiterShedError` and never hangs;
 *   - the total admission deadline stays under the enrichment-worker's 60 s
 *     STRANDED_TTL;
 *   - the breaker is per-INSTANCE (no module-global leak — the #962 / BS#955
 *     hazard) and walks closed → open → half-open → closed;
 *   - a shed returns the empty lookup shape with an `outcome` discriminator,
 *     never a terminal failure and never a `pending` write.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

// Mirror the Sentry mock used by tests/unit/services/lml.client.test.ts so the
// shed helpers' `Sentry.startSpan(..., span => ...)` seam returns the callback
// value without initializing Sentry.
const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttributes: typeof mockSpanSetAttributes };
const mockStartSpan = jest.fn((_opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
  callback({ setAttributes: mockSpanSetAttributes })
);
jest.mock('@sentry/node', () => ({
  startSpan: (opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    mockStartSpan(opts, callback),
}));

import {
  Semaphore,
  LmlCircuitBreaker,
  LimiterShedError,
  LmlClientError,
  createLmlLimiter,
  lookupMetadata,
  bulkLookupMetadata,
  shedReasonOf,
  resolveLmlPolicy,
  LML_LIMITER_MAX_QUEUE_WAIT_MS_DEFAULT,
  LML_BREAKER_FAILURE_THRESHOLD_DEFAULT,
  LML_BREAKER_OPEN_MS_DEFAULT,
} from '@wxyc/lml-client';

/** STRANDED_TTL_SECONDS lives in apps/enrichment-worker/sweep.ts. Re-typed here
 *  (not imported across the package boundary, per the spec) as the ceiling the
 *  admission deadline must stay under. */
const STRANDED_TTL_MS = 60_000;

describe('BS#1748 limiter admission bounds', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Semaphore.acquire(maxWaitMs)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves immediately when a permit is free (no deadline armed)', async () => {
      const sem = new Semaphore(1);
      await expect(sem.acquire(5000)).resolves.toBeUndefined();
      expect(sem.availablePermits).toBe(0);
    });

    it('a waiter not admitted within the deadline removes itself and throws LimiterShedError', async () => {
      const sem = new Semaphore(1);
      await sem.acquire(); // take the only permit
      const shed = sem.acquire(5000);
      // Attach a rejection handler up front so the timer-driven rejection is
      // never an unhandled promise while we advance the clock.
      const assertion = expect(shed).rejects.toBeInstanceOf(LimiterShedError);
      expect(sem.queueDepth).toBe(1);
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(sem.queueDepth).toBe(0); // waiter spliced itself out
    });

    it('N+1 concurrent acquirers: the N admitted resolve, only the overflow sheds — none hang', async () => {
      const N = 4;
      const sem = new Semaphore(N);
      // The N that fit take permits synchronously (no timer armed).
      for (let i = 0; i < N; i++) {
        await expect(sem.acquire(5000)).resolves.toBeUndefined();
      }
      const overflow = sem.acquire(5000);
      const assertion = expect(overflow).rejects.toBeInstanceOf(LimiterShedError);
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(sem.queueDepth).toBe(0);
    });

    it('a waiter admitted before the deadline resolves and cancels its timer', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      const waiting = sem.acquire(5000);
      sem.release(); // hand the permit to the waiter before the deadline
      await expect(waiting).resolves.toBeUndefined();
      // Advancing past the old deadline must not reject a now-settled waiter.
      await jest.advanceTimersByTimeAsync(10_000);
    });

    it('omitting maxWaitMs keeps the unbounded wait (job-level limiter shape)', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      let settled = false;
      const waiting = sem.acquire().then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false); // still parked — no deadline
      sem.release();
      await waiting;
      expect(settled).toBe(true);
    });
  });

  describe('deadline invariant', () => {
    it('LML_LIMITER_MAX_QUEUE_WAIT_MS + LML_CLASS5_TIMEOUT_MS < STRANDED_TTL', () => {
      const class5TimeoutMs = resolveLmlPolicy('enrichment-worker').timeoutMs;
      expect(class5TimeoutMs).toBe(29_000);
      expect(LML_LIMITER_MAX_QUEUE_WAIT_MS_DEFAULT + class5TimeoutMs).toBeLessThan(STRANDED_TTL_MS);
    });

    it('ships the spec defaults (5000 / 5 / 30000)', () => {
      expect(LML_LIMITER_MAX_QUEUE_WAIT_MS_DEFAULT).toBe(5000);
      expect(LML_BREAKER_FAILURE_THRESHOLD_DEFAULT).toBe(5);
      expect(LML_BREAKER_OPEN_MS_DEFAULT).toBe(30_000);
    });
  });

  describe('LmlCircuitBreaker state machine', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('opens after exactly failureThreshold consecutive failures', () => {
      const b = new LmlCircuitBreaker({ failureThreshold: 3, openMs: 30_000 });
      expect(b.currentState).toBe('closed');
      b.recordFailure();
      b.recordFailure();
      expect(b.currentState).toBe('closed'); // 2 < 3
      expect(b.tryAdmit()).toBe(true);
      b.recordFailure();
      expect(b.currentState).toBe('open'); // 3rd trips it
    });

    it('a success resets the consecutive-failure streak', () => {
      const b = new LmlCircuitBreaker({ failureThreshold: 3, openMs: 30_000 });
      b.recordFailure();
      b.recordFailure();
      b.recordSuccess(); // reset
      b.recordFailure();
      b.recordFailure();
      expect(b.currentState).toBe('closed'); // streak restarted at 2
      b.recordFailure();
      expect(b.currentState).toBe('open'); // now 3 consecutive
    });

    it('fast-fails while open until openMs elapses, then admits exactly one half-open probe', () => {
      const b = new LmlCircuitBreaker({ failureThreshold: 1, openMs: 30_000 });
      b.recordFailure();
      expect(b.currentState).toBe('open');
      expect(b.tryAdmit()).toBe(false);
      jest.advanceTimersByTime(29_999);
      expect(b.tryAdmit()).toBe(false); // still inside the open window
      jest.advanceTimersByTime(1);
      expect(b.tryAdmit()).toBe(true); // window elapsed → half-open probe
      expect(b.currentState).toBe('half_open');
      expect(b.tryAdmit()).toBe(false); // a second concurrent probe is blocked
    });

    it('a half-open probe success closes the breaker and resets the counter', () => {
      const b = new LmlCircuitBreaker({ failureThreshold: 1, openMs: 30_000 });
      b.recordFailure();
      jest.advanceTimersByTime(30_000);
      expect(b.tryAdmit()).toBe(true); // half-open probe
      b.recordSuccess();
      expect(b.currentState).toBe('closed');
      expect(b.tryAdmit()).toBe(true);
    });

    it('a half-open probe failure re-opens for another openMs', () => {
      const b = new LmlCircuitBreaker({ failureThreshold: 1, openMs: 30_000 });
      b.recordFailure();
      jest.advanceTimersByTime(30_000);
      expect(b.tryAdmit()).toBe(true); // half-open probe
      b.recordFailure(); // probe fails
      expect(b.currentState).toBe('open');
      expect(b.tryAdmit()).toBe(false); // re-opened, window restarted
      jest.advanceTimersByTime(30_000);
      expect(b.tryAdmit()).toBe(true); // second probe after the new window
      b.recordSuccess();
      expect(b.currentState).toBe('closed');
    });
  });

  describe('createLmlLimiter run() with breaker', () => {
    it('counts only LML timeouts (504) as failures — a fast 502 is healthy', async () => {
      const lim = createLmlLimiter({
        maxConcurrent: 5,
        ratePerMinute: 100_000,
        breaker: { failureThreshold: 2, openMs: 30_000 },
      });
      for (let i = 0; i < 5; i++) {
        await expect(lim.run(() => Promise.reject(new LmlClientError('bad gateway', 502)))).rejects.toThrow();
      }
      expect(lim.state().breakerState).toBe('closed'); // 502s never trip the breaker
    });

    it('opens on consecutive 504 timeouts and then fast-fails without calling fn', async () => {
      const lim = createLmlLimiter({
        maxConcurrent: 5,
        ratePerMinute: 100_000,
        breaker: { failureThreshold: 2, openMs: 30_000 },
      });
      for (let i = 0; i < 2; i++) {
        await expect(lim.run(() => Promise.reject(new LmlClientError('timed out', 504)))).rejects.toThrow();
      }
      expect(lim.state().breakerState).toBe('open');

      const fn = jest.fn(() => Promise.resolve('ran'));
      await expect(lim.run(fn)).rejects.toMatchObject({ reason: 'shed_breaker_open' });
      expect(fn).not.toHaveBeenCalled(); // fast-fail, no permit, no fn
    });

    it('two limiter instances hold independent breaker state (no module-global leak)', async () => {
      const a = createLmlLimiter({
        maxConcurrent: 5,
        ratePerMinute: 100_000,
        breaker: { failureThreshold: 1, openMs: 30_000 },
      });
      const b = createLmlLimiter({
        maxConcurrent: 5,
        ratePerMinute: 100_000,
        breaker: { failureThreshold: 1, openMs: 30_000 },
      });
      await expect(a.run(() => Promise.reject(new LmlClientError('timed out', 504)))).rejects.toThrow();
      expect(a.state().breakerState).toBe('open');
      expect(b.state().breakerState).toBe('closed'); // b is untouched
    });

    it('a saturation shed counts as a breaker failure', async () => {
      jest.useFakeTimers();
      try {
        const lim = createLmlLimiter({
          maxConcurrent: 1,
          ratePerMinute: 100_000,
          queueWaitMs: 5000,
          breaker: { failureThreshold: 1, openMs: 30_000 },
        });
        let release!: () => void;
        const hold = new Promise<void>((r) => {
          release = r;
        });
        const held = lim.run(() => hold); // holds the only permit
        const shed = lim.run(() => Promise.resolve('x'));
        const assertion = expect(shed).rejects.toMatchObject({ reason: 'shed_limiter_saturated' });
        await jest.advanceTimersByTimeAsync(5000);
        await assertion;
        expect(lim.state().breakerState).toBe('open'); // saturation tripped it
        release();
        await held;
      } finally {
        jest.useRealTimers();
      }
    });

    it('a limiter with no breaker/queueWaitMs is byte-identical to the pre-#1748 shape', async () => {
      const lim = createLmlLimiter({ maxConcurrent: 1, ratePerMinute: 100_000 });
      await expect(lim.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
      expect(lim.state().breakerState).toBeUndefined();
    });
  });

  describe('shedReasonOf', () => {
    it('returns the reason for each shed outcome', () => {
      expect(shedReasonOf({ outcome: 'shed_limiter_saturated' })).toBe('shed_limiter_saturated');
      expect(shedReasonOf({ outcome: 'shed_breaker_open' })).toBe('shed_breaker_open');
    });

    it('returns undefined for a non-shed response (empty, skipped, or plain)', () => {
      expect(shedReasonOf({})).toBeUndefined();
      expect(shedReasonOf({ outcome: 'skipped_discogs_unavailable' })).toBeUndefined();
    });
  });

  describe('shed → empty GatedLookupResponse on the lookup path', () => {
    /** Trip `lim`'s breaker open so the next call sheds without a wire round-trip. */
    async function openBreaker(lim: ReturnType<typeof createLmlLimiter>): Promise<void> {
      await expect(lim.run(() => Promise.reject(new LmlClientError('timed out', 504)))).rejects.toThrow();
    }

    it('lookupMetadata returns the empty shed shape with an outcome discriminator, no fetch', async () => {
      const lim = createLmlLimiter({
        maxConcurrent: 5,
        ratePerMinute: 100_000,
        breaker: { failureThreshold: 1, openMs: 30_000 },
      });
      await openBreaker(lim);
      mockFetch.mockClear();

      const res = await lookupMetadata('Juana Molina', 'DOGA', undefined, {
        limiter: lim,
        caller: 'library-enrich-artwork',
      });

      expect(res.outcome).toBe('shed_breaker_open');
      expect(res.results).toEqual([]);
      expect(res.search_type).toBe('none');
      expect(res.degraded).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled(); // never asked LML
    });

    it('bulkLookupMetadata sheds every item with a shed verdict, index-aligned, no fetch', async () => {
      const lim = createLmlLimiter({
        maxConcurrent: 5,
        ratePerMinute: 100_000,
        breaker: { failureThreshold: 1, openMs: 30_000 },
      });
      await openBreaker(lim);
      mockFetch.mockClear();

      const items = [
        {
          artist: 'Jessica Pratt',
          album: 'On Your Own Love Again',
          raw_message: 'Jessica Pratt - On Your Own Love Again',
        },
        { artist: 'Stereolab', album: 'Dots and Loops', raw_message: 'Stereolab - Dots and Loops' },
      ];
      const res = await bulkLookupMetadata(items, { limiter: lim, caller: 'enrichment-worker' });

      expect(res.results).toHaveLength(2);
      res.results.forEach((r, i) => {
        expect(r.index).toBe(i);
        expect(r.status).toBe('shed_breaker_open');
        expect(r.lookup?.outcome).toBe('shed_breaker_open');
        expect(r.lookup?.results).toEqual([]);
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
