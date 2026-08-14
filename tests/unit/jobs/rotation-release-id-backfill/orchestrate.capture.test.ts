/**
 * Pins the cooperative-pause observability BS#2147 review round 2 added to
 * this orchestrator (findings 1, 2, 3, 5). Separate file so `jest.mock` of
 * the logger module can't leak into the main orchestrate suite (which
 * relies on the real no-op logger) — same isolation pattern as
 * `concerts-poster-enrichment/orchestrate.capture.test.ts`.
 *
 * Finding 3: neither rotation job passed `onProbeError` to
 * `buildWaitForQuietPeriod`, so a `checkLiveActivity` throw was silently
 * discarded — the in-code justification ("the job entry wraps the
 * orchestrator's loop in Sentry's run-scope so captureError is unnecessary
 * here") depends on the error actually propagating, which a fail-open
 * probe never does; it stays inside `waitForQuietPeriod`'s own try/catch.
 *
 * Findings 1+2 (continued) + 5: the shared `buildWaitForQuietPeriod`
 * ceiling now throws instead of silently disabling the pause, and this
 * job's own `resolveLiveActivityMaxPauseMs` wrapper must actually reach
 * `maxTotalPauseMs`.
 */
import { jest } from '@jest/globals';
import { LiveActivityPauseCeilingExceededError } from '@wxyc/database';

import {
  runBackfill,
  resolveLiveActivityMaxPauseMs,
  type Candidate,
  type LoadCandidatesFn,
  type LookupFn,
  type WriteFn,
  type MarkAttemptedFn,
} from '../../../../jobs/rotation-release-id-backfill/orchestrate';
import { log, captureError } from '../../../../jobs/rotation-release-id-backfill/logger';

jest.mock('../../../../jobs/rotation-release-id-backfill/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
}));

const mockedLog = log as jest.MockedFunction<typeof log>;
const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

const makeLoadCandidates = (rows: Candidate[]): LoadCandidatesFn => jest.fn<LoadCandidatesFn>().mockResolvedValue(rows);

const candidate = (id: number): Candidate => ({ id, artist_name: 'Duster', album_title: 'Contemporary Movement' });

describe('runBackfill — cooperative-pause probe-error capture (BS#2147 finding 3)', () => {
  it('captures a checkLiveActivity throw via the structured logger + Sentry instead of discarding it', async () => {
    const probeError = new Error('RDS statement timeout on the live-activity probe SELECT');
    const checkLiveActivity = jest
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(probeError)
      .mockResolvedValue(false);
    const loadCandidates = makeLoadCandidates([candidate(1)]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', releaseId: 555 });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = jest.fn<MarkAttemptedFn>().mockResolvedValue({ written: true });

    await runBackfill({
      loadCandidates,
      lookup,
      write,
      markAttempted,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 1000,
      checkLiveActivity,
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(probeError, 'probe_error');
    expect(mockedLog).toHaveBeenCalledWith(
      'warn',
      'probe_error',
      expect.stringContaining('checkLiveActivity threw'),
      expect.objectContaining({ error_message: probeError.message })
    );
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('runBackfill — cooperative-pause budget ceiling (BS#2147 findings 1+2, 5)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('throws LiveActivityPauseCeilingExceededError when the injected liveActivityMaxPauseMs is exhausted', async () => {
    const checkLiveActivity = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const loadCandidates = makeLoadCandidates([candidate(1)]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', releaseId: 555 });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = jest.fn<MarkAttemptedFn>().mockResolvedValue({ written: true });

    const resultPromise = runBackfill({
      loadCandidates,
      lookup,
      write,
      markAttempted,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 1000,
      liveActivityMaxPauseMs: 2500,
      checkLiveActivity,
    });
    resultPromise.catch(() => {});

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).rejects.toThrow(LiveActivityPauseCeilingExceededError);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('resolveLiveActivityMaxPauseMs (BS#2147 finding 5)', () => {
  it('delegates to the shared resolver and honors 0 = uncapped', () => {
    expect(resolveLiveActivityMaxPauseMs('0')).toBe(0);
    expect(resolveLiveActivityMaxPauseMs('60000')).toBe(60_000);
    expect(resolveLiveActivityMaxPauseMs(undefined)).toBeGreaterThan(0);
  });

  it('names LIVE_ACTIVITY_MAX_PAUSE_MS in a resolution error', () => {
    expect(() => resolveLiveActivityMaxPauseMs('-1')).toThrow(/LIVE_ACTIVITY_MAX_PAUSE_MS/);
  });
});
