/**
 * Unit tests for the LML-client limiter's bounded queue wait + circuit
 * breaker (BS#1748).
 *
 * Problem this closes: `shared/lml-client`'s process-wide `Semaphore(5)`
 * (BS#906/G4) does an unbounded, un-timed `acquire()` before the HTTP span
 * even opens. Under sustained LML slowness, five permits draining at LML's
 * pace queue callers for minutes with no deadline and no HTTP span visible
 * to metrics. This suite pins two independent mechanisms that close that
 * gap, both fast-failing (shedding) rather than hanging:
 *
 *   1. `Semaphore.acquire(maxWaitMs)` — bounds the pre-admission queue wait.
 *   2. `LmlCircuitBreaker` — trips open after consecutive failures (queue
 *      sheds count as failures), fast-failing every call with zero queue
 *      wait until a cooldown elapses, then allows one half-open probe.
 *
 * `createLmlLimiter`'s optional `queueDeadlineMs` / `breaker` config wires
 * both into the `run()` chokepoint every LML call already shares. Omitting
 * either preserves the pre-BS#1748 unbounded-wait shape — load-bearing for
 * the backfill/job-level limiters (`jobs/flowsheet-metadata-backfill/
 * lml-limiter.ts` and siblings), which have no human-facing latency budget
 * and are meant to queue (see docs/env-vars.md's "Backfill LML rate
 * gating" section).
 *
 * A shed surfaces as `LmlSheddedError`, which extends `LmlClientError` —
 * every existing catch arm that already treats an LML failure as "leave the
 * row in its pre-terminal state for the recovery sweep" (never terminal
 * `failed`) needs no changes; a shed looks like any other transient LML
 * failure downstream (apps/enrichment-worker/enrich.ts leaves the row
 * `enriching` for the C6 sweep (#895) to revert to `pending`;
 * apps/backend/services/metadata/enrichment.service.ts and
 * library.service.ts's `enrichWithArtwork` both already catch-and-fall-back
 * on ANY LML throw).
 */
import { jest } from '@jest/globals';

const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttributes: typeof mockSpanSetAttributes };
const mockStartSpan = jest.fn(
  async (_opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    await callback({ setAttributes: mockSpanSetAttributes })
);
jest.mock('@sentry/node', () => ({
  startSpan: (opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    mockStartSpan(opts, callback),
}));

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import {
  Semaphore,
  createLmlLimiter,
  LmlCircuitBreaker,
  LmlClientError,
  LmlSheddedError,
  lookupMetadata,
  getLmlQueueDepth,
  _resetLmlClientLimitersForTest,
  DEFAULT_LML_LIMITER_QUEUE_DEADLINE_MS,
} from '@wxyc/lml-client';

describe('Semaphore queue deadline (BS#1748)', () => {
  it('acquires immediately when a permit is free, even with maxWaitMs set (no timer needed)', async () => {
    const sem = new Semaphore(1);
    await expect(sem.acquire(1000)).resolves.toBeUndefined();
    expect(sem.availablePermits).toBe(0);
  });

  it('sheds (rejects with LmlSheddedError) when no permit frees up within maxWaitMs', async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      await sem.acquire(); // drain the only permit, no deadline on this one

      const waiter = sem.acquire(1000);
      const assertion = expect(waiter).rejects.toBeInstanceOf(LmlSheddedError);

      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("tags the shed error's reason as 'queue_deadline_exceeded'", async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      await sem.acquire();

      const waiter = sem.acquire(500).catch((err: unknown) => err);
      await jest.advanceTimersByTimeAsync(500);
      const err = await waiter;

      expect(err).toBeInstanceOf(LmlSheddedError);
      expect((err as LmlSheddedError).reason).toBe('queue_deadline_exceeded');
      expect((err as LmlSheddedError).statusCode).toBe(503);
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes a shed waiter from the queue — queueDepth drops back to 0, no leaked waiter', async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      await sem.acquire();

      const waiter = sem.acquire(500).catch((err: unknown) => err);
      expect(sem.queueDepth).toBe(1);

      await jest.advanceTimersByTimeAsync(500);
      await waiter;

      expect(sem.queueDepth).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves normally (no shed) when a permit frees up before the deadline elapses', async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      await sem.acquire();

      let acquired = false;
      const waiter = sem.acquire(5000).then(() => {
        acquired = true;
      });

      await jest.advanceTimersByTimeAsync(100);
      sem.release();
      await waiter;

      expect(acquired).toBe(true);

      // The pending shed timer must have been cleared on the normal-acquire
      // path — advancing well past the original deadline must not throw an
      // unhandled rejection or otherwise disturb later state.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(sem.queueDepth).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the pre-BS#1748 unbounded-wait shape when maxWaitMs is omitted', async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      await sem.acquire();

      let acquired = false;
      const waiter = sem.acquire().then(() => {
        acquired = true;
      });

      // No deadline was passed — waiting far longer than any BS#1748 default
      // must not shed.
      await jest.advanceTimersByTimeAsync(120_000);
      expect(acquired).toBe(false);

      sem.release();
      await waiter;
      expect(acquired).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('FIFO: a later waiter is still promoted in order after an earlier waiter sheds out of the middle', async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      await sem.acquire();

      const order: string[] = [];
      const first = sem.acquire(500).then(
        () => order.push('first-acquired'),
        () => order.push('first-shed')
      );
      const second = sem.acquire().then(() => order.push('second-acquired'));

      // "first" sheds at 500ms; "second" has no deadline and stays queued.
      await jest.advanceTimersByTimeAsync(500);
      await first;
      expect(order).toEqual(['first-shed']);
      expect(sem.queueDepth).toBe(1);

      sem.release();
      await second;
      expect(order).toEqual(['first-shed', 'second-acquired']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('LmlCircuitBreaker (BS#1748)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts closed and admits calls', () => {
    const breaker = new LmlCircuitBreaker(3, 10_000);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canProceed()).toBe(true);
  });

  it('opens after `failureThreshold` consecutive failures', () => {
    const breaker = new LmlCircuitBreaker(3, 10_000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canProceed()).toBe(true);

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.canProceed()).toBe(false);
  });

  it('an interleaved success resets the consecutive-failure counter', () => {
    const breaker = new LmlCircuitBreaker(3, 10_000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();

    // 2 failures again after the reset — still short of the threshold.
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canProceed()).toBe(true);
  });

  it('stays open until resetTimeoutMs elapses, then admits exactly one half-open probe', () => {
    jest.useFakeTimers();
    const breaker = new LmlCircuitBreaker(1, 5000);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    jest.advanceTimersByTime(4999);
    expect(breaker.canProceed()).toBe(false);

    jest.advanceTimersByTime(1);
    expect(breaker.canProceed()).toBe(true);
    expect(breaker.getState()).toBe('half-open');

    // A second concurrent caller must be shed — only the admitted probe
    // may be in flight.
    expect(breaker.canProceed()).toBe(false);
  });

  it('a successful half-open probe closes the breaker', () => {
    jest.useFakeTimers();
    const breaker = new LmlCircuitBreaker(1, 5000);
    breaker.recordFailure();
    jest.advanceTimersByTime(5000);
    expect(breaker.canProceed()).toBe(true); // admits the probe

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canProceed()).toBe(true);
  });

  it('a failed half-open probe reopens the breaker and restarts the cooldown clock', () => {
    jest.useFakeTimers();
    const breaker = new LmlCircuitBreaker(1, 5000);
    breaker.recordFailure();
    jest.advanceTimersByTime(5000);
    expect(breaker.canProceed()).toBe(true); // admits the probe

    breaker.recordFailure(); // probe failed
    expect(breaker.getState()).toBe('open');

    // Cooldown restarted from THIS reopening, not the original.
    jest.advanceTimersByTime(4999);
    expect(breaker.canProceed()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(breaker.canProceed()).toBe(true);
  });
});

describe('createLmlLimiter with queueDeadlineMs + breaker (BS#1748)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sheds a call that cannot be admitted within queueDeadlineMs, without ever invoking fn', async () => {
    jest.useFakeTimers();
    try {
      const limiter = createLmlLimiter({ maxConcurrent: 1, ratePerMinute: 1000, queueDeadlineMs: 1000 });
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');

      // Occupy the sole permit indefinitely.
      let releaseFirst: (() => void) | undefined;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = limiter.run(async () => {
        await firstHeld;
        return 'first';
      });

      const second = limiter.run(fn);
      const assertion = expect(second).rejects.toBeInstanceOf(LmlSheddedError);
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;

      expect(fn).not.toHaveBeenCalled();

      releaseFirst?.();
      await first;
    } finally {
      jest.useRealTimers();
    }
  });

  it('a queue-deadline shed counts as a breaker failure', async () => {
    jest.useFakeTimers();
    try {
      const limiter = createLmlLimiter({
        maxConcurrent: 1,
        ratePerMinute: 1000,
        queueDeadlineMs: 100,
        breaker: { failureThreshold: 1, resetTimeoutMs: 10_000 },
      });

      let releaseFirst: (() => void) | undefined;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = limiter.run(async () => {
        await firstHeld;
        return 'first';
      });

      const second = limiter.run(() => Promise.resolve('second'));
      const assertion = expect(second).rejects.toBeInstanceOf(LmlSheddedError);
      await jest.advanceTimersByTimeAsync(100);
      await assertion;

      expect(limiter.state().breakerState).toBe('open');

      releaseFirst?.();
      await first;
    } finally {
      jest.useRealTimers();
    }
  });

  it('once the breaker is open, sheds immediately without touching the semaphore or calling fn', async () => {
    const limiter = createLmlLimiter({
      maxConcurrent: 2,
      ratePerMinute: 1000,
      breaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    });
    const failing = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('LML down'));
    await expect(limiter.run(failing)).rejects.toThrow('LML down');
    expect(limiter.state().breakerState).toBe('open');

    const before = limiter.state();
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
    await expect(limiter.run(fn)).rejects.toBeInstanceOf(LmlSheddedError);

    expect(fn).not.toHaveBeenCalled();
    // No permit/token was consumed by the shed call.
    expect(limiter.state().availablePermits).toBe(before.availablePermits);
    expect(limiter.state().availableTokens).toBeCloseTo(before.availableTokens, 0);
  });

  it('recovers after the cooldown: a half-open probe succeeds and closes the breaker', async () => {
    jest.useFakeTimers();
    try {
      const limiter = createLmlLimiter({
        maxConcurrent: 2,
        ratePerMinute: 1000,
        breaker: { failureThreshold: 1, resetTimeoutMs: 5000 },
      });
      await expect(limiter.run(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
      expect(limiter.state().breakerState).toBe('open');

      jest.advanceTimersByTime(5000);

      const result = await limiter.run(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
      expect(limiter.state().breakerState).toBe('closed');

      // Subsequent calls proceed normally (no longer shed).
      const again = await limiter.run(() => Promise.resolve('still-fine'));
      expect(again).toBe('still-fine');
    } finally {
      jest.useRealTimers();
    }
  });

  it('without queueDeadlineMs or breaker config, behaves exactly as before BS#1748 (no shedding)', async () => {
    const limiter = createLmlLimiter({ maxConcurrent: 1, ratePerMinute: 1000 });
    expect(limiter.state().breakerState).toBeUndefined();

    // A failing call must not open a (nonexistent) breaker or affect later calls.
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const result = await limiter.run(() => Promise.resolve('fine'));
    expect(result).toBe('fine');
  });
});

describe('LML-client limiter shed end-to-end via lookupMetadata (BS#1748)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      LIBRARY_METADATA_URL: 'http://lml.test:8000',
      LML_CLIENT_MAX_CONCURRENT: '1',
      LML_CLIENT_RATE_PER_MIN: '60000',
      LML_LIMITER_QUEUE_DEADLINE_MS: '1000',
      LML_CIRCUIT_BREAKER_THRESHOLD: '2',
      LML_CIRCUIT_BREAKER_RESET_MS: '5000',
    };
    _resetLmlClientLimitersForTest();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetLmlClientLimitersForTest();
    jest.useRealTimers();
  });

  it('a caller stuck behind a slow in-flight lookup is shed within the configured deadline, not hung', async () => {
    jest.useFakeTimers();
    try {
      let resolveFirst: (() => void) | undefined;
      const firstReady = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      mockFetch.mockImplementationOnce(async () => {
        await firstReady;
        return {
          ok: true,
          json: () => Promise.resolve({ results: [], search_type: 'none' }),
        } as unknown as globalThis.Response;
      });

      const first = lookupMetadata('Stereolab', 'Aluminum Tunes');
      // Let the first call reach fetch and occupy the sole permit.
      await jest.advanceTimersByTimeAsync(0);
      expect(getLmlQueueDepth()).toBe(0); // admitted, not queued

      const second = lookupMetadata('Cat Power', 'Moon Pix');
      const assertion = expect(second).rejects.toMatchObject({ statusCode: 503 });
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;

      // Only ONE wire call was made — the second was shed before reaching fetch.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      resolveFirst?.();
      await first;
    } finally {
      jest.useRealTimers();
    }
  });

  it('sustained LML failures trip the breaker, then a subsequent call sheds without hitting the wire, then recovers', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as globalThis.Response);

      // LML_CIRCUIT_BREAKER_THRESHOLD=2: two consecutive failures open it.
      await expect(lookupMetadata('Autechre', 'Confield')).rejects.toThrow(LmlClientError);
      await expect(lookupMetadata('Autechre', 'Confield')).rejects.toThrow(LmlClientError);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Breaker is open: a third call sheds WITHOUT another wire call.
      await expect(lookupMetadata('Autechre', 'Confield')).rejects.toBeInstanceOf(LmlSheddedError);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Heal LML and let the cooldown elapse.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);
      await jest.advanceTimersByTimeAsync(5000);

      const recovered = await lookupMetadata('Autechre', 'Confield');
      expect(recovered.results).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('BS#1748 total-deadline design invariant', () => {
  // Conservative mirror of apps/enrichment-worker/sweep.ts's
  // STRANDED_TTL_SECONDS floor (60s = 60_000ms). Duplicated as a literal
  // (not imported) because shared/lml-client cannot depend on
  // apps/enrichment-worker — see that file's own derivation comment. The
  // acceptance criterion is "total deadline < STRANDED_TTL_SECONDS": the
  // queue-admission deadline plus the longest per-call fetch timeout in the
  // tree (TIMEOUT_MS = 30s, the module's fire-and-forget default) must stay
  // under that floor with real headroom, so a shed can never take as long
  // as an actual strand would.
  const STRANDED_TTL_FLOOR_MS = 60_000;
  const LONGEST_FETCH_TIMEOUT_MS = 30_000;

  it('the default queue deadline leaves headroom under the enrichment-worker sweep TTL floor', () => {
    expect(DEFAULT_LML_LIMITER_QUEUE_DEADLINE_MS + LONGEST_FETCH_TIMEOUT_MS).toBeLessThan(STRANDED_TTL_FLOOR_MS);
  });
});
