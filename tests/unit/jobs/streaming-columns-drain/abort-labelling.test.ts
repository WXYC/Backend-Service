/**
 * How an aborted drain is LABELLED.
 *
 * The catch around the cooperative pause is deliberately not narrowed to
 * `LiveActivityPauseCeilingExceededError`: anything escaping the closure must
 * still reach the ANALYZE and cohort re-count before the run ends, and
 * narrowing would skip that accounting for exactly the errors nobody
 * anticipated. What the error class decides instead is the step tag, because
 * an unrelated failure reported as "cooperative-pause budget exhausted" sends
 * an operator to `LIVE_ACTIVITY_MAX_PAUSE_MS` — a knob that has nothing to do
 * with what actually broke.
 *
 * Separate file from `quiet-period-polarity.test.ts` so this file's logger
 * mock can't leak into the tests that assert on real log output, following
 * the `*.capture.test.ts` convention used across `jobs/`.
 *
 * @see WXYC/Backend-Service#2295
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const waitForQuietPeriod = jest.fn<() => Promise<boolean>>();

jest.mock('@wxyc/lml-client', () => ({ bulkLookupMetadata: jest.fn() }));
jest.mock('@wxyc/database', () => {
  class LiveActivityPauseCeilingExceededError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LiveActivityPauseCeilingExceededError';
    }
  }
  return {
    db: {
      transaction: jest.fn((cb: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) => {
        let call = 0;
        return cb({
          execute: () => {
            call += 1;
            return Promise.resolve(
              call === 1
                ? []
                : [{ album_id: 1, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again', n: 1 }]
            );
          },
        });
      }),
      execute: jest.fn(() => Promise.resolve([{ album_id: 1 }])),
    },
    buildWaitForQuietPeriod: () => waitForQuietPeriod,
    LiveActivityPauseCeilingExceededError,
    resolveLiveActivityPauseMs: () => 30_000,
    resolveLiveActivityMaxPauseMs: () => 1_800_000,
    LIVE_ACTIVITY_MAX_PAUSE_MS_ENV: 'LIVE_ACTIVITY_MAX_PAUSE_MS',
    requirePositiveInt: (_raw: unknown, _name: string, fallback: number) => fallback,
    requireNonNegativeInt: (_raw: unknown, _name: string, fallback: number) => fallback,
    closeDatabaseConnection: jest.fn(),
  };
});
jest.mock('../../../../jobs/streaming-columns-drain/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
  initLogger: jest.fn(),
  closeLogger: jest.fn(),
}));

import { LiveActivityPauseCeilingExceededError } from '@wxyc/database';
import { runDrain, __resetStopForTesting, type DrainOptions } from '../../../../jobs/streaming-columns-drain/job';
import { log, captureError } from '../../../../jobs/streaming-columns-drain/logger';

const mockedLog = log as jest.MockedFunction<typeof log>;
const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

/** The step tags passed to `log`, in order. */
const loggedSteps = (): string[] => mockedLog.mock.calls.map((call) => call[1]);

const OPTIONS: DrainOptions = {
  batchSize: 5,
  ratePerMin: 60_000,
  budgetMs: 25_000,
  readTimeoutMs: 1000,
  maxAlbums: 0,
  liveActivityLookbackSeconds: 300,
  liveActivityPauseMs: 30_000,
  liveActivityMaxPauseMs: 1_800_000,
  execute: true,
};

describe('runDrain — how an aborted run is labelled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('tags a genuine budget exhaustion as live_activity_pause_ceiling_exceeded', async () => {
    waitForQuietPeriod.mockRejectedValue(new LiveActivityPauseCeilingExceededError('budget exceeded'));

    await expect(runDrain(OPTIONS)).rejects.toThrow('budget exceeded');

    expect(loggedSteps()).toContain('live_activity_pause_ceiling_exceeded');
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.anything(),
      'live_activity_pause_ceiling_exceeded',
      expect.anything()
    );
  });

  it('does NOT claim the budget was exhausted when some other error escaped the pause', async () => {
    waitForQuietPeriod.mockRejectedValue(new Error('sentry transport exploded'));

    await expect(runDrain(OPTIONS)).rejects.toThrow('sentry transport exploded');

    expect(loggedSteps()).toContain('live_activity_pause_failed');
    expect(loggedSteps()).not.toContain('live_activity_pause_ceiling_exceeded');
    expect(mockedCaptureError).toHaveBeenCalledWith(expect.anything(), 'live_activity_pause_failed', expect.anything());
  });

  it('still reports the partial totals before rethrowing, so the numbers are not lost', async () => {
    waitForQuietPeriod.mockRejectedValue(new LiveActivityPauseCeilingExceededError('budget exceeded'));

    await expect(runDrain(OPTIONS)).rejects.toThrow();

    // `main`'s `finished` line never runs once `runDrain` throws, so the job
    // has to emit its own summary — a resumable drain's operator needs to know
    // how far it got.
    const summaryCall = mockedLog.mock.calls.find((call) => call[1] === 'summary');
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[3]).toMatchObject({ stopped_early: true, execute: true });
  });
});
