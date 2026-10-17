/**
 * Unit tests for jobs/flowsheet-no-match-recheck's liveness signals (BS#2187),
 * the BS#2064 recipe that `tests/unit/jobs/legacy-linkage-resolve/job.test.ts`
 * pins for `legacy-linkage-resolve`:
 *
 *   (a) a Sentry cron monitor check-in around the real run, and none on a dry
 *       run;
 *   (b) a `cronjob_runs` heartbeat on its own `:liveness` row, written on every
 *       completed non-dry run (an empty candidate batch included, so a quiet
 *       run never reads as a gap), never on a dry run or a run that throws, and
 *       read back by the next run to warn past the gap threshold.
 *
 * `runOnce` drives the real recheck body. Only its database edges are stubbed:
 * the candidate count and reads return an empty cohort, and the cursor rows
 * read as unset. That keeps this file's module mocks out of `job.test.ts`,
 * whose `runRecheckPasses` tests use the real `query.ts` constants.
 */

// `withMonitor` returns whatever the callback returns (and re-throws its
// rejection), so the stand-in is a pass-through, not an async wrapper.
const mockWithMonitor = jest.fn((_slug: string, callback: () => unknown) => callback());
const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
  close: jest.fn().mockResolvedValue(true),
  withMonitor: mockWithMonitor,
}));

jest.mock('../../../../jobs/flowsheet-no-match-recheck/query', () => ({
  ...jest.requireActual('../../../../jobs/flowsheet-no-match-recheck/query'),
  countCandidates: jest.fn(),
  loadCandidates: jest.fn(),
}));

jest.mock('../../../../jobs/flowsheet-no-match-recheck/watermark', () => ({
  ...jest.requireActual('../../../../jobs/flowsheet-no-match-recheck/watermark'),
  getCursorPosition: jest.fn(),
  setCursorPosition: jest.fn(),
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLastRunTimestamp, updateLastRun } from '@wxyc/database';
import {
  CHECKIN_MARGIN_MINUTES,
  CRON_SCHEDULE,
  LIVENESS_JOB_NAME,
  MAX_RUNTIME_MINUTES,
  MAX_RUN_GAP_HOURS_DEFAULT,
  MAX_RUN_GAP_HOURS_ENV,
  MONITOR_CONFIG,
  gapHours,
  resolveMaxRunGapHours,
  runOnce,
} from '../../../../jobs/flowsheet-no-match-recheck/job';
import { countCandidates, loadCandidates } from '../../../../jobs/flowsheet-no-match-recheck/query';
import {
  HEAD_CURSOR_JOB_NAME,
  JOB_NAME,
  getCursorPosition,
  setCursorPosition,
} from '../../../../jobs/flowsheet-no-match-recheck/watermark';

const HOUR_MS = 60 * 60 * 1000;
const CADENCE_MINUTES = 6 * 60;
const GAP_WARNING = `${JOB_NAME}.run_gap_exceeded`;

const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LIBRARY_METADATA_URL = 'http://lml.test';
  process.env.LML_API_KEY = 'test-key';
  delete process.env[MAX_RUN_GAP_HOURS_ENV];
  mockWithMonitor.mockImplementation((_slug: string, callback: () => unknown) => callback());
  (getLastRunTimestamp as jest.Mock).mockResolvedValue(null);
  (updateLastRun as jest.Mock).mockResolvedValue(undefined);
  // An empty cohort: the healthy idle run this job's liveness must not confuse with a stopped cron.
  (countCandidates as jest.Mock).mockResolvedValue(0);
  (loadCandidates as jest.Mock).mockResolvedValue([]);
  (getCursorPosition as jest.Mock).mockResolvedValue(null);
  (setCursorPosition as jest.Mock).mockResolvedValue(undefined);
});

afterAll(() => {
  process.env = savedEnv;
});

describe('flowsheet-no-match-recheck: Sentry cron monitor (BS#2187)', () => {
  it('declares a schedule identical to the crontab entry the deploy installs', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../jobs/flowsheet-no-match-recheck/package.json'), 'utf8')
    ) as { 'cron-schedule': string };

    expect(CRON_SCHEDULE).toBe(pkg['cron-schedule']);
    expect(MONITOR_CONFIG.schedule).toEqual({ type: 'crontab', value: CRON_SCHEDULE });
    expect(MONITOR_CONFIG.timezone).toBe('Etc/UTC');
  });

  it('raises an issue on one missed slot and recovers on one good check-in', () => {
    expect(MONITOR_CONFIG.failureIssueThreshold).toBe(1);
    expect(MONITOR_CONFIG.recoveryThreshold).toBe(1);
  });

  it('keeps the margin and max runtime under the 6h cadence', () => {
    expect(CHECKIN_MARGIN_MINUTES).toBeGreaterThan(0);
    expect(CHECKIN_MARGIN_MINUTES).toBeLessThan(CADENCE_MINUTES);
    expect(MAX_RUNTIME_MINUTES).toBeLessThan(CADENCE_MINUTES);
  });

  it('wraps the real run in a check-in keyed on the job name', async () => {
    await runOnce(false);

    expect(mockWithMonitor).toHaveBeenCalledTimes(1);
    expect(mockWithMonitor.mock.calls[0][0]).toBe(JOB_NAME);
    expect(mockWithMonitor.mock.calls[0][2]).toBe(MONITOR_CONFIG);
  });

  it('sends no check-in and reads no heartbeat on a dry run', async () => {
    await runOnce(true);

    expect(mockWithMonitor).not.toHaveBeenCalled();
    expect(getLastRunTimestamp).not.toHaveBeenCalled();
  });

  it('lets a thrown error propagate so the existing captureError path still fires', async () => {
    (countCandidates as jest.Mock).mockRejectedValueOnce(new Error('statement timeout'));

    await expect(runOnce(false)).rejects.toThrow('statement timeout');
    expect(mockWithMonitor).toHaveBeenCalledTimes(1);
  });
});

describe('flowsheet-no-match-recheck: cronjob_runs heartbeat (BS#2187)', () => {
  it('keeps liveness on its own cronjob_runs row, apart from the cursor rows', () => {
    expect(LIVENESS_JOB_NAME).toBe('flowsheet-no-match-recheck:liveness');
    expect([JOB_NAME, HEAD_CURSOR_JOB_NAME]).not.toContain(LIVENESS_JOB_NAME);
  });

  it.each([
    { run: 'a completed run with an empty candidate batch', dryRun: false, throws: false, heartbeats: 1 },
    { run: 'a dry run', dryRun: true, throws: false, heartbeats: 0 },
    { run: 'a run that throws', dryRun: false, throws: true, heartbeats: 0 },
  ])('$run writes $heartbeats liveness heartbeat(s)', async ({ dryRun, throws, heartbeats }) => {
    if (throws) {
      (countCandidates as jest.Mock).mockRejectedValueOnce(new Error('statement timeout'));
      await expect(runOnce(dryRun)).rejects.toThrow('statement timeout');
    } else {
      await expect(runOnce(dryRun)).resolves.toBeUndefined();
    }

    expect(updateLastRun).toHaveBeenCalledTimes(heartbeats);
    if (heartbeats > 0) {
      expect(updateLastRun).toHaveBeenCalledWith(LIVENESS_JOB_NAME, expect.any(Date));
    }
  });

  it.each([
    { previous: 'no prior heartbeat (first run)', hoursAgo: null, warns: false },
    { previous: 'a quiet run one cadence ago', hoursAgo: 6, warns: false },
    { previous: 'a run just under the threshold', hoursAgo: MAX_RUN_GAP_HOURS_DEFAULT - 0.1, warns: false },
    { previous: 'a run just past the threshold', hoursAgo: MAX_RUN_GAP_HOURS_DEFAULT + 0.1, warns: true },
    { previous: 'a run four missed slots ago', hoursAgo: 30, warns: true },
  ])('after $previous, warns: $warns', async ({ hoursAgo, warns }) => {
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(hoursAgo === null ? null : Date.now() - hoursAgo * HOUR_MS);

    await runOnce(false);

    expect(getLastRunTimestamp).toHaveBeenCalledWith(LIVENESS_JOB_NAME);
    if (warns) {
      expect(mockCaptureMessage).toHaveBeenCalledWith(GAP_WARNING, expect.objectContaining({ level: 'warning' }));
    } else {
      expect(mockCaptureMessage).not.toHaveBeenCalledWith(GAP_WARNING, expect.anything());
    }
    // The warning never fails the run: it still checks in and stamps liveness.
    expect(mockWithMonitor).toHaveBeenCalledTimes(1);
    expect(updateLastRun).toHaveBeenCalledTimes(1);
  });

  it('still runs the recheck and checks in when the gap check itself fails', async () => {
    // Telemetry must not stop the run, and must not turn into an `error`
    // check-in, which would read as the cron being down.
    (getLastRunTimestamp as jest.Mock).mockRejectedValue(new Error('cronjob_runs unreachable'));

    await expect(runOnce(false)).resolves.toBeUndefined();
    expect(mockWithMonitor).toHaveBeenCalledTimes(1);
    expect(updateLastRun).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it.each([
    [undefined, MAX_RUN_GAP_HOURS_DEFAULT],
    ['', MAX_RUN_GAP_HOURS_DEFAULT],
    ['36', 36],
  ])(`resolves ${MAX_RUN_GAP_HOURS_ENV}=%s to %s`, (raw, expected) => {
    expect(resolveMaxRunGapHours(raw)).toBe(expected);
  });

  it(`rejects a non-positive ${MAX_RUN_GAP_HOURS_ENV} rather than disabling the signal`, () => {
    expect(() => resolveMaxRunGapHours('0')).toThrow(MAX_RUN_GAP_HOURS_ENV);
  });

  it.each([
    [0, 0],
    [90 * 60 * 1000, 1.5],
    [24 * HOUR_MS, 24],
  ])('computes a %sms gap as %sh', (elapsedMs, expected) => {
    const now = Date.UTC(2026, 9, 16, 12, 0, 0);
    expect(gapHours(now - elapsedMs, now)).toBeCloseTo(expected, 6);
  });
});
