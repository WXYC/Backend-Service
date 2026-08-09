/**
 * Unit tests for `jobs/legacy-linkage-resolve` (BS#2064 liveness).
 *
 * Two things are under test here and they pull in opposite directions:
 *
 *   1. The repair cohort must stay unbounded in time. Both passes anti-join on
 *      `album_id IS NULL` and nothing else — the `cronjob_runs` row this job
 *      now writes is a liveness heartbeat, never a delta bound. The SQL-shape
 *      assertions below exist to fail loudly if someone "optimizes" the SELECTs
 *      by filtering on `last_run`, which would permanently strand every row
 *      whose `library` row landed during a window the job missed.
 *   2. A missed run must alert, and a healthy zero-candidate run must not.
 */

// `withMonitor` returns whatever the callback returns (and re-throws its
// rejection) — so the stand-in is a pass-through, not an async wrapper.
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, getLastRunTimestamp, updateLastRun } from '@wxyc/database';
import {
  CHECKIN_MARGIN_MINUTES,
  CRON_SCHEDULE,
  JOB_NAME,
  MAX_RUNTIME_MINUTES,
  MAX_RUN_GAP_HOURS_DEFAULT,
  MONITOR_CONFIG,
  gapHours,
  hasUnresolvedResidue,
  resolveMaxRunGapHours,
  runOnce,
  runResolve,
} from '../../../../jobs/legacy-linkage-resolve/job';
import { renderSql } from '../../../utils/render-sql';

const executedSql = (): string[] => (db.execute as jest.Mock).mock.calls.map((call) => renderSql(call[0]));

const findSqlMatching = (pattern: RegExp): string | undefined => executedSql().find((text) => pattern.test(text));

/**
 * Queue the four statements a full non-dry run issues, in order: flowsheet
 * COUNT, flowsheet UPDATE, rotation COUNT, rotation UPDATE. An `ANALYZE` is
 * appended after any pass that wrote, so extra resolutions get a filler.
 */
const queueRun = (
  flowsheetPass: { candidates: number; resolved: number },
  rotationPass: { candidates: number; resolved: number }
): void => {
  const execute = db.execute as jest.Mock;
  execute.mockResolvedValueOnce([{ count: flowsheetPass.candidates }]);
  if (flowsheetPass.candidates > 0) {
    execute.mockResolvedValueOnce({ count: flowsheetPass.resolved });
    if (flowsheetPass.resolved > 0) execute.mockResolvedValueOnce([]);
  }
  execute.mockResolvedValueOnce([{ count: rotationPass.candidates }]);
  if (rotationPass.candidates > 0) {
    execute.mockResolvedValueOnce({ count: rotationPass.resolved });
    if (rotationPass.resolved > 0) execute.mockResolvedValueOnce([]);
  }
};

/** A dry run issues only the two COUNTs — no UPDATE, no ANALYZE. */
const queueDryRun = (flowsheetCandidates: number, rotationCandidates: number): void => {
  const execute = db.execute as jest.Mock;
  execute.mockResolvedValueOnce([{ count: flowsheetCandidates }]);
  execute.mockResolvedValueOnce([{ count: rotationCandidates }]);
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINKAGE_RESOLVE_MAX_GAP_HOURS;
  (getLastRunTimestamp as jest.Mock).mockResolvedValue(null);
  (updateLastRun as jest.Mock).mockResolvedValue(undefined);
  mockWithMonitor.mockImplementation((_slug: string, callback: () => unknown) => callback());
});

describe('legacy-linkage-resolve: repair cohort stays unbounded in time', () => {
  it.each([
    ['flowsheet', /FROM[\s\S]*f\.legacy_release_id = l\.legacy_release_id/],
    ['rotation', /FROM[\s\S]*r\.legacy_library_release_id = l\.legacy_release_id/],
  ])('%s COUNT anti-joins on album_id IS NULL with no time predicate', async (_pass, joinPattern) => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    const countSql = executedSql().find((text) => /SELECT COUNT/i.test(text) && joinPattern.test(text));
    expect(countSql).toBeDefined();
    expect(countSql).toMatch(/album_id IS NULL/);
    // The heartbeat must never become a delta bound. Nothing that could scope
    // the cohort to "since the last run" may appear in the predicate.
    expect(countSql).not.toMatch(/cronjob_runs|last_run|INTERVAL|NOW\s*\(|add_time\s*>|updated_at\s*>/i);
  });

  it.each([
    ['flowsheet', /UPDATE[\s\S]*SET album_id = l\.id[\s\S]*f\.album_id IS NULL/],
    ['rotation', /UPDATE[\s\S]*SET album_id = l\.id[\s\S]*r\.album_id IS NULL/],
  ])('%s UPDATE anti-joins on album_id IS NULL with no time predicate', async (_pass, updatePattern) => {
    queueRun({ candidates: 5, resolved: 5 }, { candidates: 3, resolved: 3 });

    await runResolve(false);

    const updateSql = executedSql().find((text) => updatePattern.test(text));
    expect(updateSql).toBeDefined();
    expect(updateSql).not.toMatch(/cronjob_runs|last_run|INTERVAL|NOW\s*\(/i);
  });

  it('reads no cronjob_runs row into any repair statement', async () => {
    queueRun({ candidates: 2, resolved: 2 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    expect(findSqlMatching(/cronjob_runs/i)).toBeUndefined();
  });
});

describe('legacy-linkage-resolve: Sentry cron monitor (signal a)', () => {
  it('declares a schedule identical to the crontab entry the deploy installs', () => {
    // deploy-base.yml reads `cron-schedule` from package.json and writes it
    // verbatim into the EC2 crontab. Sentry upserts the monitor from
    // MONITOR_CONFIG, so drift between the two makes the monitor expect a
    // cadence the host does not run.
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../jobs/legacy-linkage-resolve/package.json'), 'utf8')
    ) as { 'cron-schedule': string };

    expect(CRON_SCHEDULE).toBe(pkg['cron-schedule']);
    expect(MONITOR_CONFIG.schedule).toEqual({ type: 'crontab', value: CRON_SCHEDULE });
    expect(MONITOR_CONFIG.timezone).toBe('Etc/UTC');
  });

  it('detects a missed run inside one cadence plus margin, and flags a wedged run before the next fires', () => {
    const cadenceMinutes = 30;
    expect(CHECKIN_MARGIN_MINUTES).toBeGreaterThan(0);
    expect(CHECKIN_MARGIN_MINUTES).toBeLessThan(cadenceMinutes);
    expect(MAX_RUNTIME_MINUTES).toBeLessThan(cadenceMinutes);
  });

  it('wraps the real run in a check-in keyed on the job name', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(mockWithMonitor).toHaveBeenCalledTimes(1);
    expect(mockWithMonitor.mock.calls[0][0]).toBe(JOB_NAME);
    expect(mockWithMonitor.mock.calls[0][2]).toBe(MONITOR_CONFIG);
  });

  it('sends no check-in on a dry run', async () => {
    queueDryRun(4, 0);

    await runOnce(true);

    expect(mockWithMonitor).not.toHaveBeenCalled();
    expect(updateLastRun).not.toHaveBeenCalled();
  });

  it('lets a thrown error propagate so the existing captureError path still fires', async () => {
    const boom = new Error('statement timeout');
    (db.execute as jest.Mock).mockRejectedValueOnce(boom);

    await expect(runOnce(false)).rejects.toThrow('statement timeout');
    expect(updateLastRun).not.toHaveBeenCalled();
  });
});

describe('legacy-linkage-resolve: cronjob_runs heartbeat (signal b)', () => {
  it('records a heartbeat after a successful run, including a zero-candidate one', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(updateLastRun).toHaveBeenCalledTimes(1);
    expect((updateLastRun as jest.Mock).mock.calls[0][0]).toBe(JOB_NAME);
    expect((updateLastRun as jest.Mock).mock.calls[0][1]).toBeInstanceOf(Date);
  });

  it('warns when the gap since the last successful run exceeds the threshold', async () => {
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(Date.now() - 9 * 60 * 60 * 1000);
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      `${JOB_NAME}.run_gap_exceeded`,
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('stays silent when the job is running on cadence', async () => {
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(Date.now() - 30 * 60 * 1000);
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('stays silent on the very first run, when no heartbeat exists yet', async () => {
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(null);
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('still runs the repair and checks in when the gap check itself fails', async () => {
    // Observability must not be able to stop the repair, and must not skip the
    // check-in — that would turn a broken gap read into a phantom "cron is
    // down" alert.
    (getLastRunTimestamp as jest.Mock).mockRejectedValue(new Error('cronjob_runs unreachable'));
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await expect(runOnce(false)).resolves.toBeDefined();
    expect(mockWithMonitor).toHaveBeenCalledTimes(1);
    expect(updateLastRun).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it.each([
    [undefined, MAX_RUN_GAP_HOURS_DEFAULT],
    ['', MAX_RUN_GAP_HOURS_DEFAULT],
    ['12', 12],
  ])('resolves LINKAGE_RESOLVE_MAX_GAP_HOURS=%s to %s', (raw, expected) => {
    expect(resolveMaxRunGapHours(raw)).toBe(expected);
  });

  it('rejects a non-positive LINKAGE_RESOLVE_MAX_GAP_HOURS rather than disabling the signal', () => {
    expect(() => resolveMaxRunGapHours('0')).toThrow(/LINKAGE_RESOLVE_MAX_GAP_HOURS/);
  });

  it.each([
    [0, 0],
    [90 * 60 * 1000, 1.5],
    [4 * 60 * 60 * 1000, 4],
  ])('computes a %sms gap as %sh', (elapsedMs, expected) => {
    const now = Date.UTC(2026, 7, 9, 12, 0, 0);
    expect(gapHours(now - elapsedMs, now)).toBeCloseTo(expected, 6);
  });
});

describe('legacy-linkage-resolve: drain check (signal c)', () => {
  it.each([
    ['a healthy idle run', { candidates: 0, resolved: 0 }, false],
    ['a fully drained run', { candidates: 12, resolved: 12 }, false],
    ['a run that picked up mid-run arrivals', { candidates: 12, resolved: 14 }, false],
    ['a run that saw candidates and wrote none', { candidates: 12, resolved: 0 }, true],
    ['a run that wrote only part of the cohort', { candidates: 12, resolved: 5 }, true],
  ])('%s', (_label, passResult, expected) => {
    expect(hasUnresolvedResidue(passResult)).toBe(expected);
  });

  it('does not alert on a healthy zero-candidate run', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('does not alert when both passes drain fully', async () => {
    queueRun({ candidates: 7, resolved: 7 }, { candidates: 2, resolved: 2 });

    await runOnce(false);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('warns per pass when the UPDATE writes fewer rows than the COUNT saw', async () => {
    queueRun({ candidates: 7, resolved: 3 }, { candidates: 2, resolved: 0 });

    await runOnce(false);

    const steps = mockCaptureMessage.mock.calls.map((call) => (call[1] as { tags: { step: string } }).tags.step);
    expect(steps).toEqual(['drain-flowsheet', 'drain-rotation']);
    expect(mockCaptureMessage.mock.calls[0][0]).toBe(`${JOB_NAME}.unresolved_candidates`);
  });

  it('does not run the drain check on a dry run, which writes nothing by design', async () => {
    queueDryRun(9, 0);

    await runOnce(true);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
