/**
 * Unit tests for the legacy-mirror-reconcile entrypoint helpers (BS#1707):
 * option parsing, the single-flight advisory-lock acquire/bail, and the
 * per-DJ `backend-mirror` flag evaluator.
 *
 * `main()` is guarded behind `NODE_ENV==='test'`, so importing the module
 * doesn't fire a run against the mocked DB.
 */

import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => ({
  __esModule: true,
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { checkLiveActivity as mockCheckLiveActivity, LiveActivityPauseCeilingExceededError } from '@wxyc/database';

import {
  ADVISORY_LOCK_KEY,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  makeFlagEvaluator,
  resolveOptions,
  buildAwaitQuietWindow,
  RECONCILE_WINDOW_HOURS_ENV,
  RECONCILE_SETTLE_MINUTES_ENV,
  RECONCILE_ALERT_THRESHOLD_ENV,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  LIVE_ACTIVITY_PAUSE_MS_ENV,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
  STALE_OPEN_SHOW_HOURS_ENV,
  type AdvisoryLockClient,
} from '../../../../jobs/legacy-mirror-reconcile/job';
import type { PostHog } from 'posthog-node';

describe('resolveOptions', () => {
  const CLEAN: NodeJS.ProcessEnv = {};

  it('applies the documented defaults', () => {
    expect(resolveOptions(CLEAN)).toEqual({
      windowHours: 48,
      settleMinutes: 15,
      alertThreshold: 0,
      staleAfterHours: 12,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 30_000,
      liveActivityMaxPauseMs: 1_800_000,
    });
  });

  it('honors env overrides', () => {
    const opts = resolveOptions({
      [RECONCILE_WINDOW_HOURS_ENV]: '72',
      [RECONCILE_SETTLE_MINUTES_ENV]: '30',
      [RECONCILE_ALERT_THRESHOLD_ENV]: '5',
      [LIVE_ACTIVITY_LOOKBACK_ENV]: '120',
      [LIVE_ACTIVITY_PAUSE_MS_ENV]: '15000',
      [STALE_OPEN_SHOW_HOURS_ENV]: '18',
      [LIVE_ACTIVITY_MAX_PAUSE_MS_ENV]: '60000',
    });
    expect(opts).toEqual({
      windowHours: 72,
      settleMinutes: 30,
      alertThreshold: 5,
      staleAfterHours: 18,
      liveActivityLookbackSeconds: 120,
      liveActivityPauseMs: 15_000,
      liveActivityMaxPauseMs: 60_000,
    });
  });

  it('rejects a zero or negative stale-open-show threshold (BS#2065)', () => {
    expect(() => resolveOptions({ [STALE_OPEN_SHOW_HOURS_ENV]: '0' })).toThrow(/STALE_OPEN_SHOW_HOURS/);
    expect(() => resolveOptions({ [STALE_OPEN_SHOW_HOURS_ENV]: '-4' })).toThrow(/STALE_OPEN_SHOW_HOURS/);
  });

  it('accepts settle=0 (disables the settle bound) but rejects a negative window', () => {
    expect(resolveOptions({ [RECONCILE_SETTLE_MINUTES_ENV]: '0' }).settleMinutes).toBe(0);
    expect(() => resolveOptions({ [RECONCILE_WINDOW_HOURS_ENV]: '-1' })).toThrow(/RECONCILE_WINDOW_HOURS/);
  });
});

/**
 * BS#2147 review round 2, finding 4: `awaitQuietWindow` used to rebuild
 * `buildWaitForQuietPeriod` FRESH on every call — and `ports.awaitQuiet()`
 * is invoked at FOUR sites in `orchestrate.ts` (two run checkpoints before
 * each sweep's candidate query, plus two per-row sites inside each sweep's
 * `for (const show of candidates)` loop), not only at "discrete
 * checkpoints" as an earlier version of this docstring claimed. A fresh
 * closure per call resets `pausedMs` to 0 every time, so the cumulative-
 * pause ceiling never actually accumulated: total pause across a run was
 * bounded by N-candidate-shows x maxTotalPauseMs, not by maxTotalPauseMs
 * itself. `buildAwaitQuietWindow` now builds the closure ONCE per run
 * (mirroring every other converted job) and `buildPorts` reuses that same
 * closure across all four `ports.awaitQuiet()` calls.
 */
describe('buildAwaitQuietWindow (BS#2147 review finding 4)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    (mockCheckLiveActivity as jest.Mock).mockReset();
    (mockCheckLiveActivity as jest.Mock).mockResolvedValue(false);
  });

  it('accumulates the cooperative-pause budget across separate awaitQuiet() calls within one run', async () => {
    // Activity clears BETWEEN calls (the realistic "intermittent" shape a
    // live show produces across many `awaitQuiet()` call sites): each
    // separate invocation sees exactly one active probe (pauses once) then
    // one quiet probe (returns cleanly). Three such calls accrue ~3000ms of
    // pause against a 2500ms ceiling with pauseMs=1000 -- but the
    // exhaustion check only runs on an ACTIVE probe, so with a PERSISTENT
    // closure it trips on the very first probe of the NEXT call, proving
    // the budget survived across calls rather than resetting on each one.
    let probeCount = 0;
    (mockCheckLiveActivity as jest.Mock).mockImplementation(() => {
      probeCount += 1;
      return Promise.resolve(probeCount % 2 === 1);
    });

    const awaitQuiet = buildAwaitQuietWindow(60, 1000, 2500);

    for (let i = 0; i < 3; i++) {
      const call = awaitQuiet();
      call.catch(() => {});
      await jest.advanceTimersByTimeAsync(1000);
      await expect(call).resolves.toBeUndefined();
    }

    // A fourth call: under the old per-call-rebuild bug this would probe
    // fresh from pausedMs=0 and never throw, no matter how many prior
    // calls happened. With the budget persisted in one closure, the
    // accumulated ~3000ms already exceeds the 2500ms ceiling.
    await expect(awaitQuiet()).rejects.toThrow(LiveActivityPauseCeilingExceededError);
  });

  it('throws LiveActivityPauseCeilingExceededError once maxTotalPauseMs is exhausted within a single call too (BS#2147 findings 1+2)', async () => {
    (mockCheckLiveActivity as jest.Mock).mockResolvedValue(true);
    const awaitQuiet = buildAwaitQuietWindow(60, 1000, 2000);

    const call = awaitQuiet();
    call.catch(() => {});
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(call).rejects.toThrow(LiveActivityPauseCeilingExceededError);
  });

  it('maxTotalPauseMs=0 is uncapped (BS#2147 finding 5 escape hatch)', async () => {
    (mockCheckLiveActivity as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const awaitQuiet = buildAwaitQuietWindow(60, 1000, 0);

    const call = awaitQuiet();
    call.catch(() => {});
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(call).resolves.toBeUndefined();
  });
});

describe('advisory lock (single-flight)', () => {
  const makeClient = (rows: Array<Record<string, unknown>>): AdvisoryLockClient & { unsafe: jest.Mock } => ({
    unsafe: jest.fn(() => Promise.resolve(rows)),
  });

  it('acquires when pg_try_advisory_lock returns true', async () => {
    const client = makeClient([{ locked: true }]);
    await expect(acquireAdvisoryLock(client, ADVISORY_LOCK_KEY)).resolves.toBe(true);
    expect(client.unsafe).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
  });

  it('bails (returns false) when another reconcile holds the lock', async () => {
    const client = makeClient([{ locked: false }]);
    await expect(acquireAdvisoryLock(client, ADVISORY_LOCK_KEY)).resolves.toBe(false);
  });

  it('release issues pg_advisory_unlock for the same key', async () => {
    const client = makeClient([{ pg_advisory_unlock: true }]);
    await releaseAdvisoryLock(client, ADVISORY_LOCK_KEY);
    expect(client.unsafe).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  });
});

describe('makeFlagEvaluator', () => {
  it('enables the mirror when PostHog is unconfigured (null client)', async () => {
    const evaluate = makeFlagEvaluator(null);
    await expect(evaluate('dj-1')).resolves.toBe(true);
  });

  it('enables the mirror when there is no DJ to key on', async () => {
    const client = { isFeatureEnabled: jest.fn() } as unknown as PostHog;
    const evaluate = makeFlagEvaluator(client);
    await expect(evaluate(null)).resolves.toBe(true);
    expect((client as unknown as { isFeatureEnabled: jest.Mock }).isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('evaluates the per-DJ flag when configured', async () => {
    const isFeatureEnabled = jest.fn<(flag: string, id: string) => Promise<boolean | undefined>>();
    const client = { isFeatureEnabled } as unknown as PostHog;
    const evaluate = makeFlagEvaluator(client);

    isFeatureEnabled.mockResolvedValueOnce(true);
    await expect(evaluate('dj-on')).resolves.toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith('backend-mirror', 'dj-on');

    isFeatureEnabled.mockResolvedValueOnce(false);
    await expect(evaluate('dj-off')).resolves.toBe(false);

    // Undefined (flag not found) resolves closed.
    isFeatureEnabled.mockResolvedValueOnce(undefined);
    await expect(evaluate('dj-unknown')).resolves.toBe(false);
  });
});
