/**
 * Pin the cooperative-pause defaults so the values in `tests/mocks/database.mock.ts`
 * (which consumer unit tests import via `@wxyc/database`) can't drift from the
 * real values silently.
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { jest } from '@jest/globals';

import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
  LIVE_ACTIVITY_MIN_PAUSE_MS,
  LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
  resolveLiveActivityPauseMs,
  resolveLiveActivityMaxPauseMs,
  buildWaitForQuietPeriod,
  buildDefaultSleep,
  LiveActivityPauseCeilingExceededError,
  type CheckLiveActivityFn,
} from '../../../shared/database/src/live-activity';
import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT as MOCK_LOOKBACK,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT as MOCK_PAUSE,
  LIVE_ACTIVITY_MIN_PAUSE_MS as MOCK_MIN_PAUSE_MS,
  LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT as MOCK_MAX_PAUSE_MS_DEFAULT,
  resolveLiveActivityPauseMs as mockResolveLiveActivityPauseMs,
  resolveLiveActivityMaxPauseMs as mockResolveLiveActivityMaxPauseMs,
  buildWaitForQuietPeriod as mockBuildWaitForQuietPeriod,
  buildDefaultSleep as mockBuildDefaultSleep,
  LiveActivityPauseCeilingExceededError as MockLiveActivityPauseCeilingExceededError,
} from '../../mocks/database.mock';

/**
 * BS#2147 review round 2, finding 7: the prior version of this suite pinned
 * only two of the four cooperative-pause constants and never touched the
 * mock's copy of the loop itself, so a real-module fix (like the throw this
 * same review round adds — findings 1+2) was invisible to every one of the
 * 12 job suites that resolve `@wxyc/database` to `tests/mocks/database.mock.ts`.
 * The mock's own comment overstated the protection: it claimed the contract
 * "is pinned against the actual module by this file", but the constant-only
 * checks below it never covered the loop body at all.
 *
 * BS#2147 review round 2, LOW finding 5: finding 7's fix above still pinned
 * only the loop (`buildWaitForQuietPeriod`/`buildDefaultSleep`) and two of
 * the four constants — `resolveLiveActivityPauseMs`, `resolveLiveActivityMaxPauseMs`,
 * and `LiveActivityPauseCeilingExceededError` were hand-copied into the mock
 * but never compared against the real module, so a future floor/ceiling
 * resolver change (or a rename of the thrown error) could diverge silently
 * while every job suite kept testing the mock's stale copy. Extended to
 * cover all three with the same `Function.prototype.toString()` approach.
 */
describe('live-activity defaults', () => {
  it('shared/database default matches database mock', () => {
    expect(MOCK_LOOKBACK).toBe(LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT);
    expect(MOCK_PAUSE).toBe(LIVE_ACTIVITY_PAUSE_MS_DEFAULT);
    expect(MOCK_MIN_PAUSE_MS).toBe(LIVE_ACTIVITY_MIN_PAUSE_MS);
    expect(MOCK_MAX_PAUSE_MS_DEFAULT).toBe(LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT);
  });

  // Byte-for-byte source comparison: a mock that computes the same answer via
  // different code would pass a behavioral test suite and still miss the
  // NEXT real-module fix, which is exactly how the throw this review round
  // adds would have gone unnoticed by the mock without this check.
  it('mock buildWaitForQuietPeriod is byte-identical to the real implementation', () => {
    expect(mockBuildWaitForQuietPeriod.toString()).toBe(buildWaitForQuietPeriod.toString());
  });

  it('mock buildDefaultSleep is byte-identical to the real implementation', () => {
    expect(mockBuildDefaultSleep.toString()).toBe(buildDefaultSleep.toString());
  });

  it('mock resolveLiveActivityPauseMs is byte-identical to the real implementation', () => {
    expect(mockResolveLiveActivityPauseMs.toString()).toBe(resolveLiveActivityPauseMs.toString());
  });

  it('mock resolveLiveActivityMaxPauseMs is byte-identical to the real implementation', () => {
    expect(mockResolveLiveActivityMaxPauseMs.toString()).toBe(resolveLiveActivityMaxPauseMs.toString());
  });

  it('mock LiveActivityPauseCeilingExceededError is byte-identical to the real implementation', () => {
    expect(MockLiveActivityPauseCeilingExceededError.toString()).toBe(LiveActivityPauseCeilingExceededError.toString());
  });
});

/**
 * BS#2147 AC #1, part 1: the resolver rejects every value in the bad
 * interval, not just `0`. `LIVE_ACTIVITY_PAUSE_MS=1` hot-loops exactly like
 * `0` does — the sleep between re-probes is 1ms, bounded only by RDS
 * round-trip latency — so `requirePositiveInt`-style "just reject zero"
 * would leave the defect reachable at `1`. This test fails against `main`
 * today: the pre-BS#2147 resolver used `requireNonNegativeInt`, which
 * accepts `0` (and everything else in [0, MIN_PAUSE_MS)) without complaint.
 */
describe('resolveLiveActivityPauseMs (BS#2147 floor)', () => {
  it('falls back to the default when unset', () => {
    expect(resolveLiveActivityPauseMs(undefined, 'LIVE_ACTIVITY_PAUSE_MS')).toBe(LIVE_ACTIVITY_PAUSE_MS_DEFAULT);
  });

  it('accepts a value at or above the floor', () => {
    expect(resolveLiveActivityPauseMs(String(LIVE_ACTIVITY_MIN_PAUSE_MS), 'LIVE_ACTIVITY_PAUSE_MS')).toBe(
      LIVE_ACTIVITY_MIN_PAUSE_MS
    );
    expect(resolveLiveActivityPauseMs('60000', 'LIVE_ACTIVITY_PAUSE_MS')).toBe(60_000);
  });

  it.each(['0', '1', '999'])('rejects a sub-floor value (%s) with a named error', (raw) => {
    expect(() => resolveLiveActivityPauseMs(raw, 'LIVE_ACTIVITY_PAUSE_MS')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
    expect(() => resolveLiveActivityPauseMs(raw, 'LIVE_ACTIVITY_PAUSE_MS')).toThrow(
      new RegExp(String(LIVE_ACTIVITY_MIN_PAUSE_MS))
    );
  });

  it('rejects a negative or non-integer value the same way the underlying int parser always has', () => {
    expect(() => resolveLiveActivityPauseMs('-1', 'LIVE_ACTIVITY_PAUSE_MS')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
    expect(() => resolveLiveActivityPauseMs('abc', 'LIVE_ACTIVITY_PAUSE_MS')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
  });

  it('names the caller-supplied env var, not a hardcoded one, in the error', () => {
    expect(() => resolveLiveActivityPauseMs('0', 'BACKFILL_BREAKER_PAUSE_MS')).toThrow(/BACKFILL_BREAKER_PAUSE_MS/);
  });
});

describe('resolveLiveActivityMaxPauseMs', () => {
  it('falls back to the default when unset', () => {
    expect(resolveLiveActivityMaxPauseMs(undefined)).toBe(LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT);
  });

  it('accepts 0 as "uncapped"', () => {
    expect(resolveLiveActivityMaxPauseMs('0')).toBe(0);
  });

  it('accepts a custom value', () => {
    expect(resolveLiveActivityMaxPauseMs('60000')).toBe(60_000);
  });

  it('defaults the env name to LIVE_ACTIVITY_MAX_PAUSE_MS', () => {
    expect(() => resolveLiveActivityMaxPauseMs('-1')).toThrow(new RegExp(LIVE_ACTIVITY_MAX_PAUSE_MS_ENV));
  });
});

/** Deterministic fake clock: each call advances by a fixed step. */
const buildStepClock = (stepMs: number): (() => number) => {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
};

const instantSleep = async (): Promise<void> => {
  /* no-op: tests control elapsed time via the injected `now`, not real sleep */
};

describe('buildWaitForQuietPeriod', () => {
  it('short-circuits to false without probing when lookbackSeconds <= 0', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
    const waitForQuietPeriod = buildWaitForQuietPeriod({ lookbackSeconds: 0, pauseMs: 5000, probe });

    await expect(waitForQuietPeriod()).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('resolves false immediately once the probe reports quiet', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);
    const waitForQuietPeriod = buildWaitForQuietPeriod({ lookbackSeconds: 60, pauseMs: 5000, probe });

    await expect(waitForQuietPeriod()).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(60);
  });

  it('honors shouldStop: returns true without sleeping once activity is detected and a stop is pending', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
    const sleep = jest.fn(instantSleep);
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 5000,
      probe,
      shouldStop: () => true,
      sleep,
    });

    await expect(waitForQuietPeriod()).resolves.toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is fail-open on a probe throw: fires onProbeError and treats the loop as quiet', async () => {
    const err = new Error('transient RDS blip');
    const probe = jest.fn<CheckLiveActivityFn>().mockRejectedValue(err);
    const onProbeError = jest.fn();
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 5000,
      probe,
      onProbeError,
    });

    await expect(waitForQuietPeriod()).resolves.toBe(false);
    expect(onProbeError).toHaveBeenCalledWith(err);
  });

  it('fires onPause with the running pausedMs total before each sleep', async () => {
    const probe = jest
      .fn<CheckLiveActivityFn>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const onPause = jest.fn();
    const now = buildStepClock(1000);
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 5000,
      probe,
      onPause,
      sleep: instantSleep,
      now,
    });

    await waitForQuietPeriod();

    expect(onPause).toHaveBeenCalledTimes(2);
    expect(onPause).toHaveBeenNthCalledWith(1, { lookbackSeconds: 60, pauseMs: 5000, pausedMs: 0 });
    expect(onPause).toHaveBeenNthCalledWith(2, { lookbackSeconds: 60, pauseMs: 5000, pausedMs: 1000 });
  });

  /**
   * BS#2147 AC #1, part 2 (review round 2, findings 1+2): with activity
   * permanently detected and an injected sub-floor `pauseMs` (the only way
   * to reach one now that the resolver floors the env path), the probe is
   * still called a BOUNDED number of times — the elapsed-time cap, not the
   * sleep, is what bounds it — and exhaustion THROWS rather than silently
   * disabling the pause. The first cut of this cap made exhaustion a sticky
   * "give up and proceed" flag: a long show would exhaust the budget mid-run
   * and the pause would switch off permanently while a DJ was still live —
   * the exact hazard the cap exists to prevent. `onBudgetExhausted` fires
   * with the accrued `pausedMs` FIRST (so a caller can log context), then a
   * named `LiveActivityPauseCeilingExceededError` is thrown, uncaught, out
   * of the closure — mirroring `BreakerPauseCeilingExceededError` in
   * `jobs/flowsheet-metadata-backfill/lml-health.ts`, the repo's existing
   * answer for this exact ceiling shape. Ported accrual semantics from
   * `jobs/rotation-release-id-pollution-check/job.py`'s `make_pause_probe`:
   * cumulative wall-clock is measured from the TOP of each iteration (probe
   * time included), so a `pauseMs=0` misconfiguration still accrues "query
   * time" (here, the injected clock step) and stays bounded. A naive/
   * unbounded implementation would hang this test rather than fail it, so
   * the clock is deterministic (a fixed step per call) — no real waiting, no
   * reliance on wall-clock flake.
   */
  it('throws LiveActivityPauseCeilingExceededError on budget exhaustion, firing onBudgetExhausted first', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true); // permanently "active"
    const calls: string[] = [];
    const onBudgetExhausted = jest.fn((pausedMs: number) => {
      calls.push(`onBudgetExhausted:${pausedMs}`);
    });
    const now = buildStepClock(500); // each now() call advances the fake clock by 500ms
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 0, // sub-floor; unreachable via the resolver, but the helper must not assume that
      probe,
      maxTotalPauseMs: 1000,
      onBudgetExhausted,
      sleep: instantSleep,
      now,
    });

    await expect(waitForQuietPeriod()).rejects.toThrow(LiveActivityPauseCeilingExceededError);

    // Each iteration's loopStart/accrual now() pair advances pausedMs by
    // exactly 500ms (two now() calls per iteration, one intervening step):
    // iter1 checks pausedMs=0 (<1000) -> pauses -> pausedMs becomes 500.
    // iter2 checks pausedMs=500 (<1000) -> pauses -> pausedMs becomes 1000.
    // iter3 checks pausedMs=1000 (>=1000) -> exhausted -> throws.
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
    expect(onBudgetExhausted).toHaveBeenCalledWith(1000);
    // onBudgetExhausted must fire BEFORE the throw, so a caller's log line
    // carries context that predates the abort, not a line racing it.
    expect(calls).toEqual(['onBudgetExhausted:1000']);
  });

  it('the thrown error names the ceiling and the accrued pause time', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
    const now = buildStepClock(500);
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 0,
      probe,
      maxTotalPauseMs: 1000,
      sleep: instantSleep,
      now,
    });

    await expect(waitForQuietPeriod()).rejects.toMatchObject({
      name: 'LiveActivityPauseCeilingExceededError',
      message: expect.stringMatching(/1000/),
    });
  });

  it('is NOT sticky: a later call re-evaluates and throws again rather than silently proceeding', async () => {
    // Deleting the sticky `exhausted` flag was deliberate (review findings
    // 1+2): its only purpose was to make the old silent-proceed path
    // idempotent, and a throw already makes that path unreachable. A caller
    // that (incorrectly) keeps invoking the closure after it threw gets the
    // SAME loud failure every time, never a quiet fallback to full-speed.
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
    const now = buildStepClock(1000);
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 0,
      probe,
      maxTotalPauseMs: 500,
      sleep: instantSleep,
      now,
    });

    await expect(waitForQuietPeriod()).rejects.toThrow(LiveActivityPauseCeilingExceededError);
    const callsAfterFirstInvocation = probe.mock.calls.length;
    expect(callsAfterFirstInvocation).toBeGreaterThan(0);

    await expect(waitForQuietPeriod()).rejects.toThrow(LiveActivityPauseCeilingExceededError);

    // A second invocation probes again (pausedMs never resets, so the very
    // next check is already >= the ceiling) rather than returning silently.
    expect(probe.mock.calls.length).toBeGreaterThan(callsAfterFirstInvocation);
  });

  it('maxTotalPauseMs=0 means uncapped: budget exhaustion never fires', async () => {
    let calls = 0;
    const probe = jest.fn<CheckLiveActivityFn>().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(calls <= 5); // quiet after 5 iterations
    });
    const onBudgetExhausted = jest.fn();
    const now = buildStepClock(10_000_000); // huge step; would exhaust instantly if the cap were active
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 0,
      probe,
      maxTotalPauseMs: 0,
      onBudgetExhausted,
      sleep: instantSleep,
      now,
    });

    await expect(waitForQuietPeriod()).resolves.toBe(false);
    expect(onBudgetExhausted).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('measures cap accrual from the top of the loop, including probe time, not just the sleep', async () => {
    // pauseMs=0 contributes nothing; the clock only advances inside the probe
    // itself (simulating real RDS round-trip time), proving accrual counts
    // probe time, not merely time spent inside `sleep`.
    let clock = 0;
    const now = () => clock;
    const probe = jest.fn<CheckLiveActivityFn>().mockImplementation(() => {
      clock += 600;
      return Promise.resolve(true);
    });
    const onBudgetExhausted = jest.fn();
    const waitForQuietPeriod = buildWaitForQuietPeriod({
      lookbackSeconds: 60,
      pauseMs: 0,
      probe,
      maxTotalPauseMs: 1000,
      onBudgetExhausted,
      sleep: instantSleep,
      now,
    });

    await expect(waitForQuietPeriod()).rejects.toThrow(LiveActivityPauseCeilingExceededError);

    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
    // iter1: pausedMs 0 (<1000) -> pause; probe adds 600 -> pausedMs=600
    // iter2: pausedMs 600 (<1000) -> pause; probe adds 600 -> pausedMs=1200
    // iter3: pausedMs 1200 (>=1000) -> exhausted -> throws
    expect(probe).toHaveBeenCalledTimes(3);
  });

  /**
   * BS#2147 review finding 8: the ported Python reference
   * (`jobs/rotation-release-id-pollution-check/job.py`'s `make_pause_probe`)
   * uses `time.monotonic()`; the first TS cut used `Date.now()` for the same
   * budget accounting. A wall-clock backward NTP step during a pause makes
   * `now() - loopStart` negative and DECREMENTS `pausedMs`; a forward step
   * exhausts the budget early. `performance.now()` is Node's monotonic
   * clock — immune to both. `buildDefaultSleep`'s own `Date.now()` is
   * deliberately untouched (matches the pre-existing `stopAwareSleep`; not a
   * regression to fix here).
   */
  it('uses performance.now, not Date.now, as the default budget clock', async () => {
    const perfSpy = jest.spyOn(performance, 'now');
    const dateSpy = jest.spyOn(Date, 'now');
    try {
      const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);
      const waitForQuietPeriod = buildWaitForQuietPeriod({ lookbackSeconds: 60, pauseMs: 5000, probe });

      await waitForQuietPeriod();

      expect(perfSpy).toHaveBeenCalled();
      // A quiet-on-first-probe run never sleeps and never re-checks the
      // budget, so nothing in THIS call chain has a reason to read
      // Date.now() — the loop's own clock reads are exclusively performance.now.
      expect(dateSpy).not.toHaveBeenCalled();
    } finally {
      perfSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  describe('default sleep (real timers)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('actually waits pauseMs (via ticked setTimeout) before re-probing, and is stop-aware mid-wait', async () => {
      const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValueOnce(true).mockResolvedValue(false);
      const waitForQuietPeriod = buildWaitForQuietPeriod({ lookbackSeconds: 60, pauseMs: 1200, probe });

      const resultPromise = waitForQuietPeriod();
      await jest.advanceTimersByTimeAsync(0);
      // Only the first (activity-detected) probe has fired; the real sleep
      // hasn't elapsed yet, so the re-probe must not have happened.
      expect(probe).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1200);
      await expect(resultPromise).resolves.toBe(false);
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('bails out of a real sleep early when shouldStop flips true mid-wait', async () => {
      let stop = false;
      const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
      const waitForQuietPeriod = buildWaitForQuietPeriod({
        lookbackSeconds: 60,
        pauseMs: 10_000,
        probe,
        shouldStop: () => stop,
      });

      const resultPromise = waitForQuietPeriod();
      await jest.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(1);

      stop = true;
      // The default sleep ticks in <=500ms slices; one tick is enough to
      // observe the flipped flag and return early.
      await jest.advanceTimersByTimeAsync(500);
      await expect(resultPromise).resolves.toBe(true);
    });
  });
});
