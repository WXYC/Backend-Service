/**
 * Unit tests for `jobs/legacy-linkage-resolve` (BS#2064 liveness, hardened by BS#2071).
 *
 * Two things are under test here and they pull in opposite directions:
 *
 *   1. The repair cohort must stay unbounded in time. Both passes anti-join on
 *      `album_id IS NULL` and nothing else — the `cronjob_runs` row this job
 *      now writes is a liveness heartbeat, never a delta bound. The SQL-shape
 *      assertions below exist to fail loudly if someone "optimizes" the
 *      cohort by filtering on `last_run`, which would permanently strand
 *      every row whose `library` row landed during a window the job missed.
 *   2. A missed run must alert, and a healthy zero-candidate run must not —
 *      and, per BS#2071, so must a run that merely raced a benign concurrent
 *      write; only a genuine non-draining UPDATE may alert.
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
import * as logger from '../../../../jobs/legacy-linkage-resolve/logger';
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

/** Whitespace-normalized rendered SQL, for the allowlist snapshot assertions below. */
const normalizedExecutedSql = (): string[] => executedSql().map((text) => text.replace(/\s+/g, ' ').trim());

const findSqlMatching = (pattern: RegExp): string | undefined => executedSql().find((text) => pattern.test(text));

/**
 * BS#2071: `candidates` and `resolved` now come back from a single
 * data-modifying CTE, in one row — there is no longer a separate "residual"
 * value to mock independently. Production code derives
 * `residual = max(candidates - resolved, 0)` from exactly this pair, which is
 * the fix: residual can no longer disagree with candidates/resolved the way
 * a separately-issued post-write re-COUNT used to be able to (that was the
 * shape BS#2071 replaced — see `hasUnresolvedResidue`'s docblock in job.ts).
 */
type PassMock = { candidates: number; resolved: number };

/**
 * Queue one pass's statements for a REAL (non-dry) run: the single combined
 * cohort-count-and-UPDATE CTE, then — only if it actually wrote something —
 * the conditional ANALYZE. Unlike the pre-BS#2071 shape, this issues exactly
 * one statement even for a zero-candidate pass: the combined statement itself
 * is what measures `candidates`, so there's nothing to check first.
 */
const queuePass = (execute: jest.Mock, pass: PassMock): void => {
  execute.mockResolvedValueOnce([{ candidates: pass.candidates, resolved: pass.resolved }]);
  if (pass.resolved > 0) execute.mockResolvedValueOnce([]); // ANALYZE
};

/** Queue both passes' statements for a full non-dry run, flowsheet then rotation. */
const queueRun = (flowsheetPass: PassMock, rotationPass: PassMock): void => {
  const execute = db.execute as jest.Mock;
  queuePass(execute, flowsheetPass);
  queuePass(execute, rotationPass);
};

/** A dry run issues only the two candidate COUNTs — no combined statement, no ANALYZE. */
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
  /**
   * BS#2071: the denylist this block used to assert against
   * (`/cronjob_runs|last_run|INTERVAL|NOW\(\)|add_time\s*>|updated_at\s*>/i`)
   * only catches spellings someone thought to enumerate — it misses
   * `l.last_modified > $1`, `f.add_date >= $1`, `CURRENT_TIMESTAMP`, `age(...)`,
   * a subquery against a different watermark table, or a bound value computed
   * in JS and passed as a plain parameter (`> $1`). None of those match a
   * pattern built from today's guesses.
   *
   * Flipped to an allowlist instead: each statement's full text, whitespace-
   * normalized, is asserted equal to a fixed constant. Any added conjunct —
   * regardless of spelling, regardless of whether it's a literal or a bound
   * `$1` — changes the normalized text and fails the assertion. Updating
   * these constants is a deliberate, reviewable act, not a pattern to slip
   * past.
   *
   * BS#2071 (this revision) folded each pass's COUNT and UPDATE into one
   * data-modifying CTE (`resolveFlowsheetAlbumIds`/`resolveRotationAlbumIds`
   * in job.ts), so the allowlisted text below covers the whole combined
   * statement rather than a COUNT and an UPDATE separately. The plain
   * COUNT-only statement survives only on the `--dry-run` path, which must
   * count without writing.
   *
   * `${flowsheet}`/`${rotation}`/`${library}` render as `''` under the mock
   * (`tests/mocks/database.mock.ts` models each as a plain object of
   * `{ column: 'column' }` entries, which `renderValue` treats as "table
   * reference, contributes nothing to rendered text") — hence "FROM f" below
   * reading as if the alias immediately followed the keyword.
   */
  const FLOWSHEET_COUNT_SQL =
    'SELECT COUNT(*)::int AS count FROM f JOIN l ON f.legacy_release_id = l.legacy_release_id ' +
    'WHERE f.legacy_release_id IS NOT NULL AND f.album_id IS NULL';
  const ROTATION_COUNT_SQL =
    'SELECT COUNT(*)::int AS count FROM r JOIN l ON r.legacy_library_release_id = l.legacy_release_id ' +
    'WHERE r.legacy_library_release_id IS NOT NULL AND r.album_id IS NULL';
  const FLOWSHEET_DRAIN_SQL =
    'WITH cohort AS ( SELECT f.id FROM f JOIN l ON f.legacy_release_id = l.legacy_release_id ' +
    'WHERE f.legacy_release_id IS NOT NULL AND f.album_id IS NULL ), upd AS ( UPDATE f SET album_id = l.id ' +
    'FROM l, cohort c WHERE f.id = c.id AND f.legacy_release_id = l.legacy_release_id RETURNING 1 ) ' +
    'SELECT (SELECT COUNT(*)::int FROM cohort) AS candidates, (SELECT COUNT(*)::int FROM upd) AS resolved';
  const ROTATION_DRAIN_SQL =
    'WITH cohort AS ( SELECT r.id FROM r JOIN l ON r.legacy_library_release_id = l.legacy_release_id ' +
    'WHERE r.legacy_library_release_id IS NOT NULL AND r.album_id IS NULL ), upd AS ( UPDATE r ' +
    'SET album_id = l.id, artist_name = NULL, album_title = NULL, record_label = NULL FROM l, cohort c ' +
    'WHERE r.id = c.id AND r.legacy_library_release_id = l.legacy_release_id RETURNING 1 ) ' +
    'SELECT (SELECT COUNT(*)::int FROM cohort) AS candidates, (SELECT COUNT(*)::int FROM upd) AS resolved';

  it('flowsheet drain statement matches the allowlisted statement exactly — no added predicate survives', async () => {
    queueRun({ candidates: 5, resolved: 5 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    expect(normalizedExecutedSql()).toContain(FLOWSHEET_DRAIN_SQL);
  });

  it('rotation drain statement matches the allowlisted statement exactly — no added predicate survives', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 3, resolved: 3 });

    await runResolve(false);

    expect(normalizedExecutedSql()).toContain(ROTATION_DRAIN_SQL);
  });

  it('a zero-candidate real-run pass still issues its combined statement once, and never an ANALYZE', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    // The combined statement is what measures `candidates` — there's no
    // separate pre-check to skip, so it always runs exactly once per pass,
    // real or idle. Only a resolved write earns a follow-up ANALYZE.
    expect(normalizedExecutedSql()).toEqual([FLOWSHEET_DRAIN_SQL, ROTATION_DRAIN_SQL]);
  });

  it('a dry run issues only the two candidate COUNTs — no combined statement, no ANALYZE', async () => {
    queueDryRun(4, 2);

    await runResolve(true);

    expect(normalizedExecutedSql()).toEqual([FLOWSHEET_COUNT_SQL, ROTATION_COUNT_SQL]);
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
  /**
   * `hasUnresolvedResidue` only ever looks at `residual`. BS#2071 (this
   * revision) means `residual` is always `max(candidates - resolved, 0)`,
   * computed from a single-snapshot CTE — so there's no longer a meaningful
   * "candidates/resolved disagree with residual" case to exercise at this
   * pure-function layer (that used to be exactly the bug: a separately-
   * issued post-write re-COUNT could disagree with `candidates - resolved`).
   * That guarantee is exercised at the `runOnce` layer below, where the mock
   * only ever supplies `{ candidates, resolved }` and production code is the
   * only thing that computes `residual`.
   */
  it.each([
    [0, false],
    [1, true],
    [7, true],
    [12, true],
  ])('residual=%s -> hasUnresolvedResidue=%s', (residual, expected) => {
    expect(hasUnresolvedResidue({ candidates: 12, resolved: 12 - residual, residual })).toBe(expected);
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

  it(
    'does not alert on the acceptance-criterion scenario: fully drained by this pass, with more candidates ' +
      'arriving after this statement completes',
    async () => {
      // BS#2071's issue body walks through exactly this shape: a pass sees 12
      // candidates, resolves all 12 in the same statement that counted them,
      // and — completely separately, after this statement has already
      // committed — 3 more rows become candidates (most plausibly
      // `library-etl`, which shares this job's exact `*/30 * * * *` slot).
      // Under the old post-write-recount shape that scenario reported
      // `residual: 3` and alerted on a perfect run. Under the single-snapshot
      // CTE, those 3 later arrivals are not part of this statement's result
      // at all — there is no query left that could see them — so the mocked
      // result is just the fully-drained `{ candidates: 12, resolved: 12 }`
      // this pass actually measured, and there is nothing to alert on.
      queueRun({ candidates: 12, resolved: 12 }, { candidates: 0, resolved: 0 });

      await runOnce(false);

      expect(mockCaptureMessage).not.toHaveBeenCalled();
    }
  );

  it('does not warn when a concurrent operator run already resolved what this pass saw as candidates (acceptance criterion: benign race)', async () => {
    // Acceptance criterion: "A concurrent one-shot broken-fk-recovery run, or
    // a deleted/edited candidate row, does not produce an
    // unresolved_candidates warning." A row a concurrent repairer already
    // resolved before this statement's snapshot was taken never enters
    // `cohort` in the first place — it drops out of `candidates`, not just
    // `resolved` — so the shape this pass actually measures is a smaller,
    // still fully-drained cohort, not a shortfall.
    queueRun({ candidates: 9, resolved: 9 }, { candidates: 0, resolved: 0 });

    await runOnce(false);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('still warns when the UPDATE genuinely does not drain its own cohort, per pass', async () => {
    queueRun({ candidates: 7, resolved: 3 }, { candidates: 2, resolved: 0 });

    await runOnce(false);

    const steps = mockCaptureMessage.mock.calls.map((call) => (call[1] as { tags: { step: string } }).tags.step);
    expect(steps).toEqual(['drain-flowsheet', 'drain-rotation']);
    expect(mockCaptureMessage.mock.calls[0][0]).toBe(`${JOB_NAME}.unresolved_candidates`);
    expect(mockCaptureMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({ extra: expect.objectContaining({ candidates: 7, resolved: 3, residual: 4 }) })
    );
  });

  it('does not run the drain check on a dry run, which writes nothing by design', async () => {
    queueDryRun(9, 0);

    await runOnce(true);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('logs residual as null, not 0, on a dry run — 0 would misreport a nonzero cohort as fully drained', async () => {
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    queueDryRun(12, 0);

    await runResolve(true);

    const flowsheetCall = logSpy.mock.calls.find((call) => call[1] === 'resolve-flowsheet');
    expect(flowsheetCall?.[3]).toEqual(expect.objectContaining({ candidates: 12, resolved: 0, residual: null }));

    logSpy.mockRestore();
  });
});
