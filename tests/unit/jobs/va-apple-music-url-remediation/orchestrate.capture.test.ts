/**
 * Pins the cursor-logging fix BS#2147 review round 2 (findings 1+2) adds to
 * this orchestrator. Separate file so `jest.mock` of the logger module can't
 * leak into the main orchestrate suite (which relies on the real no-op
 * logger) — same isolation pattern as
 * `concerts-poster-enrichment/orchestrate.capture.test.ts`.
 *
 * Every sibling job that resolves `runXXX` via a REJECTION on cooperative-
 * pause budget exhaustion already carries its resume cursor into that
 * throw's context — either because the outer function-level catch already
 * logs `last_id`/cursors (apple-music-url-backfill and friends resolve
 * `result.failed` with cursors intact) or, for the reject-shaped jobs
 * (rotation-*, flowsheet-artwork-repair), there's simply no per-phase
 * resumable cursor to lose. This job is different: `runFlowsheetPhase` and
 * `runAlbumPhase` each keep a phase-local `cursor` that is NEVER caught
 * anywhere between the `waitForQuietPeriod()` call site and the promise
 * rejecting out of `runRemediation` — so, unfixed, an operator reading the
 * failure has no idea which `VA_REMEDIATION_FLOWSHEET_AFTER_ID` /
 * `VA_REMEDIATION_ALBUM_AFTER_ID` to resume from. Each phase now wraps its
 * `waitForQuietPeriod()` call in a local try/catch that logs + captures the
 * phase's own `after_id` before rethrowing.
 */
import { jest } from '@jest/globals';
import { LiveActivityPauseCeilingExceededError } from '@wxyc/database';

import {
  runRemediation,
  type FlowsheetFix,
  type AlbumInvalidation,
} from '../../../../jobs/va-apple-music-url-remediation/orchestrate';
import { log, captureError } from '../../../../jobs/va-apple-music-url-remediation/logger';

const mockErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

jest.mock('../../../../jobs/va-apple-music-url-remediation/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
  errorMessage: (error: unknown) => mockErrorMessage(error),
}));

const mockedLog = log as jest.MockedFunction<typeof log>;
const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

const withUrl = (url: string) => ({ results: [{ artwork: { apple_music_url: url } }] });

const passThroughApply = jest.fn((fixes: FlowsheetFix[]) => Promise.resolve(fixes.length));
const noopInvalidate = jest.fn((targets: AlbumInvalidation[]) => Promise.resolve(targets.length));
const noopAnalyze = jest.fn(async () => {});

const baseOpts = (overrides: Record<string, unknown> = {}) => ({
  dryRun: false,
  applyBatchFn: passThroughApply as never,
  invalidateAlbumFn: noopInvalidate as never,
  analyzeFn: noopAnalyze as never,
  ...overrides,
});

describe('runFlowsheetPhase — cursor logged on cooperative-pause budget exhaustion (BS#2147 findings 1+2)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '60';
    process.env.LIVE_ACTIVITY_PAUSE_MS = '1000';
    process.env.LIVE_ACTIVITY_MAX_PAUSE_MS = '2000';
    process.env.VA_REMEDIATION_FLOWSHEET_AFTER_ID = '4200';
    process.env.VA_REMEDIATION_SECOND_PASS_DELAY_MS = '0';
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS;
    delete process.env.LIVE_ACTIVITY_PAUSE_MS;
    delete process.env.LIVE_ACTIVITY_MAX_PAUSE_MS;
    delete process.env.VA_REMEDIATION_FLOWSHEET_AFTER_ID;
    delete process.env.VA_REMEDIATION_SECOND_PASS_DELAY_MS;
  });

  it('logs and captures the flowsheet resume cursor before the ceiling throw escapes', async () => {
    const checkLive = jest.fn(() => Promise.resolve(true));

    const resultPromise = runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl('https://music.apple.com/us/song/new/1')),
        checkLiveActivityFn: checkLive,
      })
    );
    resultPromise.catch(() => {});

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).rejects.toThrow(LiveActivityPauseCeilingExceededError);

    // The fix: the phase-local cursor (seeded here from
    // VA_REMEDIATION_FLOWSHEET_AFTER_ID, since exhaustion strikes before any
    // page loads) is captured to Sentry and the structured log before the
    // throw propagates — an operator reading either can tell exactly which
    // cursor to resume from.
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.any(LiveActivityPauseCeilingExceededError),
      'live_activity_pause_ceiling_exceeded',
      expect.objectContaining({ after_id: 4200 })
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'error',
      'live_activity_pause_ceiling_exceeded',
      expect.any(String),
      expect.objectContaining({ after_id: 4200 })
    );
    expect(passThroughApply).not.toHaveBeenCalled();
  });
});
