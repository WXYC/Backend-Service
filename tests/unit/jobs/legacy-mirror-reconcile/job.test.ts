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

import {
  ADVISORY_LOCK_KEY,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  makeFlagEvaluator,
  resolveOptions,
  RECONCILE_WINDOW_HOURS_ENV,
  RECONCILE_SETTLE_MINUTES_ENV,
  RECONCILE_ALERT_THRESHOLD_ENV,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  LIVE_ACTIVITY_PAUSE_MS_ENV,
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
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 30_000,
    });
  });

  it('honors env overrides', () => {
    const opts = resolveOptions({
      [RECONCILE_WINDOW_HOURS_ENV]: '72',
      [RECONCILE_SETTLE_MINUTES_ENV]: '30',
      [RECONCILE_ALERT_THRESHOLD_ENV]: '5',
      [LIVE_ACTIVITY_LOOKBACK_ENV]: '120',
      [LIVE_ACTIVITY_PAUSE_MS_ENV]: '15000',
    });
    expect(opts).toEqual({
      windowHours: 72,
      settleMinutes: 30,
      alertThreshold: 5,
      liveActivityLookbackSeconds: 120,
      liveActivityPauseMs: 15_000,
    });
  });

  it('accepts settle=0 (disables the settle bound) but rejects a negative window', () => {
    expect(resolveOptions({ [RECONCILE_SETTLE_MINUTES_ENV]: '0' }).settleMinutes).toBe(0);
    expect(() => resolveOptions({ [RECONCILE_WINDOW_HOURS_ENV]: '-1' })).toThrow(/RECONCILE_WINDOW_HOURS/);
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
