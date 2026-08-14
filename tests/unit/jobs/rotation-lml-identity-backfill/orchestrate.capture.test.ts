/**
 * Pins the cooperative-pause observability BS#2147 review round 2 added to
 * this orchestrator (findings 1, 2, 3, 5). Separate file so `jest.mock` of
 * the logger module can't leak into the main orchestrate suite (which
 * relies on the real no-op logger) — same isolation pattern as
 * `concerts-poster-enrichment/orchestrate.capture.test.ts`.
 *
 * Finding 3: neither rotation job passed `onProbeError` to
 * `buildWaitForQuietPeriod`, so a `checkLiveActivity` throw (an RDS
 * statement timeout on the probe SELECT, say) was silently discarded —
 * the in-code justification ("no log/captureError available at this
 * layer") was factually wrong: this file already imports `Sentry` for
 * `Sentry.startSpan`, and its own `logger.ts` was simply never imported.
 *
 * Findings 1+2 (continued) + 5: the shared `buildWaitForQuietPeriod`
 * ceiling now throws instead of silently disabling the pause, and this
 * job's own `resolveLiveActivityMaxPauseMs` wrapper must actually reach
 * `maxTotalPauseMs` — a knob that reads tunable but isn't is the exact
 * shape BS#2147 exists to close.
 */
import { jest } from '@jest/globals';
import { LiveActivityPauseCeilingExceededError } from '@wxyc/database';

import {
  runBackfill,
  resolveLiveActivityMaxPauseMs,
  type LoadCandidatesFn,
  type LookupFn,
  type WriteFn,
} from '../../../../jobs/rotation-lml-identity-backfill/orchestrate';
import { log, captureError } from '../../../../jobs/rotation-lml-identity-backfill/logger';
import type { Candidate } from '../../../../jobs/rotation-lml-identity-backfill/query';

jest.mock('../../../../jobs/rotation-lml-identity-backfill/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
}));

const mockedLog = log as jest.MockedFunction<typeof log>;
const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

const makeLoadCandidates = (rows: Candidate[]): LoadCandidatesFn => jest.fn<LoadCandidatesFn>().mockResolvedValue(rows);

describe('runBackfill — cooperative-pause probe-error capture (BS#2147 finding 3)', () => {
  it('captures a checkLiveActivity throw via the structured logger + Sentry instead of discarding it', async () => {
    const probeError = new Error('RDS statement timeout on the live-activity probe SELECT');
    const checkLiveActivity = jest
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(probeError)
      .mockResolvedValue(false);
    const loadCandidates = makeLoadCandidates([{ id: 1, discogs_release_id: 111 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(222);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    await runBackfill({
      loadCandidates,
      lookup,
      write,
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
    // Fail-open: the probe throw does not abort the run.
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('runBackfill — cooperative-pause budget ceiling (BS#2147 findings 1+2, 5)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('throws LiveActivityPauseCeilingExceededError when the injected liveActivityMaxPauseMs is exhausted', async () => {
    const checkLiveActivity = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const loadCandidates = makeLoadCandidates([{ id: 1, discogs_release_id: 111 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(222);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const resultPromise = runBackfill({
      loadCandidates,
      lookup,
      write,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 1000,
      liveActivityMaxPauseMs: 2500,
      checkLiveActivity,
    });
    // Swallow the eventual rejection so it isn't reported as unhandled while
    // fake timers are advanced below.
    resultPromise.catch(() => {});

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).rejects.toThrow(LiveActivityPauseCeilingExceededError);
    // Never reaches a lookup/write — the run aborted during the pause.
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves maxTotalPauseMs uncapped by default (LIVE_ACTIVITY_MAX_PAUSE_MS unset) so a short-lived pause never exhausts', async () => {
    const checkLiveActivity = jest.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValue(false);
    const loadCandidates = makeLoadCandidates([{ id: 1, discogs_release_id: 111 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(222);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const resultPromise = runBackfill({
      loadCandidates,
      lookup,
      write,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 1000,
      checkLiveActivity,
    });

    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toMatchObject({ totals: { resolved: 1 } });
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
