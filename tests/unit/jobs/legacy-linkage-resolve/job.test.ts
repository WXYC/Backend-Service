/**
 * Unit tests for `jobs/legacy-linkage-resolve` (BS#2064 liveness, hardened by
 * BS#2071, lock-guarded by BS#2413).
 *
 * Three things are under test here and the first two pull in opposite
 * directions:
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
 *   3. BS#2413: neither pass may wait on a lock for minutes. A pass with
 *      nothing to do issues no UPDATE at all, and a pass that does have work
 *      bounds its lock wait with `SET LOCAL lock_timeout` inside an explicit
 *      transaction, standing down cleanly on `55P03`/`40P01` rather than
 *      burning the 300 s `statement_timeout` and reporting a generic
 *      "Failed query". The stand-down must be visible: its own Sentry
 *      warning, and a heartbeat deliberately NOT advanced.
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
import { db, flowsheet, library, rotation, getLastRunTimestamp, updateLastRun } from '@wxyc/database';
import * as logger from '../../../../jobs/legacy-linkage-resolve/logger';
import {
  CHECKIN_MARGIN_MINUTES,
  CRON_SCHEDULE,
  JOB_NAME,
  LINKAGE_LOCK_TIMEOUT_MS,
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
 * The raw `db.execute` argument for the statement whose rendered text matches
 * `pattern`. Used by the table-identity assertions below, which need the
 * PRE-render `{ values }` array rather than the rendered string.
 *
 * Selects by content, not by call index: BS#2413 put a candidate pre-check and
 * a `SET LOCAL lock_timeout` ahead of each pass's CTE, so a positional index
 * would have to be re-derived every time the statement sequence changes.
 */
const executeCallMatching = (pattern: RegExp): { values: unknown[] } | undefined =>
  (db.execute as jest.Mock).mock.calls.find((call) => pattern.test(renderSql(call[0])))?.[0] as
    { values: unknown[] } | undefined;

/**
 * A Postgres rejection in the shape the job ACTUALLY catches.
 *
 * postgres-js puts the SQLSTATE on `error.code`, but nothing in this job ever
 * sees a bare driver error: drizzle-orm wraps every query rejection in a
 * `DrizzleQueryError` whose own `message` is the generic `Failed query: …`,
 * whose own `code` is `undefined`, and whose `.cause` is the driver error
 * (`drizzle-orm/errors.js`; the wrap is unconditional, in
 * `pg-core/session.js`'s `queryWithCache`). A test double that throws a bare
 * `{ code }` passes against a classifier that only reads `error.code` while
 * production fails every stand-down — so the default here is the WRAPPED
 * shape, and `bare` is the opt-out used by the one test that pins the
 * fallback path.
 */
const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const drizzleWrapped = (cause: Error): Error => Object.assign(new Error('Failed query: <sql>\nparams: '), { cause });

/**
 * `55P03` (`lock_not_available`) is our own `lock_timeout` firing; `40P01`
 * (`deadlock_detected`) is the deadlock detector picking us as the victim.
 */
const lockContentionError = (code: '55P03' | '40P01' = '55P03', shape: 'wrapped' | 'bare' = 'wrapped'): Error => {
  const driverError = pgError(code, 'canceling statement due to lock timeout');
  return shape === 'bare' ? driverError : drizzleWrapped(driverError);
};

/**
 * BS#2071: `candidates` and `resolved` now come back from a single
 * data-modifying CTE, in one row — there is no longer a separate "residual"
 * value to mock independently. Production code derives
 * `residual = max(candidates - resolved, 0)` from exactly this pair, which is
 * the fix: residual can no longer disagree with candidates/resolved the way
 * a separately-issued post-write re-COUNT used to be able to (that was the
 * shape BS#2071 replaced — see `hasUnresolvedResidue`'s docblock in job.ts).
 */
type PassMock = {
  candidates: number;
  resolved: number;
  /**
   * What the BS#2413 pre-check COUNT saw, when that must differ from what the
   * CTE goes on to measure. Defaults to `candidates`. The two are allowed to
   * disagree — the pre-check is a gate, never an input to the drain
   * comparison; see the "pre-check count never reaches the drain check" test.
   */
  precheck?: number;
  /** Reject the CTE with a lock-contention SQLSTATE instead of resolving it. */
  defer?: '55P03' | '40P01';
};

/**
 * Queue one pass's statements for a REAL (non-dry) run:
 *
 *   1. the standalone candidate COUNT pre-check (BS#2413). A pass that sees
 *      zero returns here and issues nothing else — no transaction, no
 *      `SET LOCAL`, no UPDATE, and so no lock request at all: not on the
 *      `library_watermark` singleton the rotation statement trigger takes,
 *      and not on the `library` rows either pass's FK check reads.
 *   2. `SET LOCAL lock_timeout`, then the combined cohort-count-and-UPDATE
 *      CTE, both inside one explicit transaction (the `SET LOCAL` only binds
 *      there under the postgres-js driver).
 *   3. only if the CTE actually wrote something, the conditional ANALYZE —
 *      deliberately outside the transaction.
 */
const queuePass = (execute: jest.Mock, pass: PassMock): void => {
  const seen = pass.precheck ?? pass.candidates;
  execute.mockResolvedValueOnce([{ count: seen }]);
  if (seen === 0) return;
  execute.mockResolvedValueOnce([]); // SET LOCAL lock_timeout
  if (pass.defer) {
    execute.mockRejectedValueOnce(lockContentionError(pass.defer));
    return;
  }
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
   * BS#2071 folded each pass's COUNT and UPDATE into one data-modifying CTE
   * (`resolveFlowsheetAlbumIds`/`resolveRotationAlbumIds` in job.ts), so the
   * allowlisted text below covers the whole combined statement rather than a
   * COUNT and an UPDATE separately.
   *
   * BS#2413 put the plain COUNT back in FRONT of that CTE as a gate — a pass
   * that sees no candidates issues no UPDATE, and therefore never queues
   * behind whoever holds the `library_watermark` singleton row. That is a
   * second, independent use of the same statement, not a revival of the
   * two-snapshot comparison BS#2071 removed: the pre-check's number decides
   * only whether to run the CTE, and is discarded the moment it does. The CTE
   * remains the sole source of both `candidates` and `resolved`.
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
  // BS#2071 (predicate-drop fix): `upd` repeats `f.album_id IS NULL` /
  // `r.album_id IS NULL` in its own WHERE clause, not just `cohort`'s — see
  // job.ts's docblock on `resolveFlowsheetAlbumIds` for why the re-check
  // matters under EvalPlanQual. `cohort` also selects `DISTINCT` id, cheap
  // insurance against a future index change (see the same docblock).
  const FLOWSHEET_DRAIN_SQL =
    'WITH cohort AS ( SELECT DISTINCT f.id FROM f JOIN l ON f.legacy_release_id = l.legacy_release_id ' +
    'WHERE f.legacy_release_id IS NOT NULL AND f.album_id IS NULL ), upd AS ( UPDATE f SET album_id = l.id ' +
    'FROM l, cohort c WHERE f.id = c.id AND f.legacy_release_id = l.legacy_release_id AND f.album_id IS NULL ' +
    'RETURNING 1 ) SELECT (SELECT COUNT(*)::int FROM cohort) AS candidates, (SELECT COUNT(*)::int FROM upd) AS resolved';
  const ROTATION_DRAIN_SQL =
    'WITH cohort AS ( SELECT DISTINCT r.id FROM r JOIN l ON r.legacy_library_release_id = l.legacy_release_id ' +
    'WHERE r.legacy_library_release_id IS NOT NULL AND r.album_id IS NULL ), upd AS ( UPDATE r ' +
    'SET album_id = l.id, artist_name = NULL, album_title = NULL, record_label = NULL FROM l, cohort c ' +
    'WHERE r.id = c.id AND r.legacy_library_release_id = l.legacy_release_id AND r.album_id IS NULL ' +
    'RETURNING 1 ) SELECT (SELECT COUNT(*)::int FROM cohort) AS candidates, (SELECT COUNT(*)::int FROM upd) AS resolved';
  // BS#2413. Allowlisted alongside the repair statements because it is the
  // guard that keeps them from waiting five minutes, and a silent drop would
  // restore the failure mode without changing any other assertion here.
  const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LINKAGE_LOCK_TIMEOUT_MS}ms'`;

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

  /**
   * The allowlist above pins predicates, not table identity: every
   * interpolated `${flowsheet}`/`${rotation}`/`${library}` renders as `''`
   * under `renderSql` (see `tests/utils/render-sql.ts`'s `isMockTableShape`),
   * so swapping which table object gets interpolated at a given `${...}`
   * site — e.g. joining `${rotation}` where `${library}` belongs — leaves the
   * whitespace-normalized text, and therefore the FLOWSHEET_DRAIN_SQL /
   * ROTATION_DRAIN_SQL assertions above, unchanged. This checks the
   * PRE-render call args directly instead: `db.execute`'s raw `{ values }`
   * array holds the actual interpolated objects in template order, and
   * `flowsheet`/`library`/`rotation` (imported from the same `@wxyc/database`
   * mock job.ts resolves to) are distinct objects with non-overlapping key
   * sets, so `toEqual` here fails on a table-identity swap that the
   * text-only allowlist cannot see.
   */
  it('flowsheet drain statement interpolates flowsheet/library, not a swapped table, at each ${...} site', async () => {
    queueRun({ candidates: 5, resolved: 5 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    const drainCall = executeCallMatching(/upd AS/);
    expect(drainCall?.values).toEqual([flowsheet, library, flowsheet, library]);
  });

  it('rotation drain statement interpolates rotation/library, not a swapped table, at each ${...} site', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 3, resolved: 3 });

    await runResolve(false);

    const drainCall = executeCallMatching(/upd AS/);
    expect(drainCall?.values).toEqual([rotation, library, rotation, library]);
  });

  it('a zero-candidate real-run pass issues its pre-check COUNT and nothing else — no UPDATE, no ANALYZE', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    // BS#2413: the whole point of the pre-check. On the ~98% of runs with
    // nothing to repair, this job now issues two MVCC-safe SELECTs and takes
    // no write lock at all — where the BS#2071 shape ran its UPDATE arm
    // unconditionally and so could queue behind `library-etl`'s quarter-hour
    // transaction for a run that had nothing to do. A statement-level trigger
    // fires even on `UPDATE 0`, so "the cohort is empty" was never protection.
    expect(normalizedExecutedSql()).toEqual([FLOWSHEET_COUNT_SQL, ROTATION_COUNT_SQL]);
  });

  it('a pass with work wraps its CTE in a transaction that bounds the lock wait first', async () => {
    queueRun({ candidates: 5, resolved: 5 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    // `SET LOCAL` only binds inside an explicit transaction under the
    // postgres-js driver, and it must precede the statement it bounds.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const statements = normalizedExecutedSql();
    expect(statements[0]).toBe(FLOWSHEET_COUNT_SQL);
    expect(statements[1]).toBe(SET_LOCK_TIMEOUT_SQL);
    expect(statements[2]).toBe(FLOWSHEET_DRAIN_SQL);
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

describe('legacy-linkage-resolve: UPDATE re-checks album_id IS NULL against a concurrent writer (BS#2071 predicate-drop regression)', () => {
  /**
   * Regression pin for the exact defect this revision fixes: folding the
   * COUNT-then-UPDATE pair into one data-modifying CTE dropped
   * `AND f.album_id IS NULL` (and, on rotation, `AND r.album_id IS NULL`)
   * from the `upd` arm's own WHERE clause — `cohort`'s identical filter is
   * NOT a substitute for it.
   *
   * Under READ COMMITTED, if a concurrent writer (e.g. an MD calling
   * `updateEntry`, `apps/backend/services/flowsheet.service.ts`, to pick an
   * album for a flowsheet entry) commits a write to a `cohort` row while
   * this statement is still executing, Postgres's EvalPlanQual re-checks the
   * UPDATE's OWN WHERE clause — not `cohort`'s — against that row's
   * just-committed new version before writing it. Without this predicate on
   * `upd` itself, the re-checked qual (`f.id = c.id AND f.legacy_release_id
   * = l.legacy_release_id`) still matches no matter what the concurrent
   * writer just set `album_id` to, so this job silently overwrites it and
   * reports a perfectly healthy `resolved === candidates`. With the
   * predicate restored, the re-check fails once `album_id` is no longer
   * NULL, the row drops out of `upd`, and the concurrent writer's value
   * survives.
   *
   * A live-Postgres demonstration of exactly this clobber (before this fix)
   * and its prevention (after) is in the BS#2071 PR body. This test is the
   * fast, DB-free CI pin: it fails immediately if the predicate is ever
   * dropped from `upd`'s WHERE clause again, on either pass, without needing
   * a real database to prove why that matters.
   */
  it('flowsheet UPDATE carries album_id IS NULL on its own WHERE clause, immediately before RETURNING', async () => {
    queueRun({ candidates: 3, resolved: 3 }, { candidates: 0, resolved: 0 });

    await runResolve(false);

    const flowsheetSql = findSqlMatching(/upd AS/)
      ?.replace(/\s+/g, ' ')
      .trim();
    // Distinguishes the UPDATE's own predicate (right before `RETURNING 1`)
    // from `cohort`'s otherwise-identical `AND f.album_id IS NULL` earlier in
    // the same statement (which is followed by `),`, not `RETURNING 1`).
    expect(flowsheetSql).toContain(
      'WHERE f.id = c.id AND f.legacy_release_id = l.legacy_release_id AND f.album_id IS NULL RETURNING 1'
    );
  });

  it('rotation UPDATE carries album_id IS NULL on its own WHERE clause, immediately before RETURNING', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 3, resolved: 3 });

    await runResolve(false);

    const rotationSql = findSqlMatching(/upd AS/)
      ?.replace(/\s+/g, ' ')
      .trim();
    expect(rotationSql).toContain(
      'WHERE r.id = c.id AND r.legacy_library_release_id = l.legacy_release_id AND r.album_id IS NULL RETURNING 1'
    );
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
    expect(hasUnresolvedResidue({ candidates: 12, resolved: 12 - residual, residual, deferred: false })).toBe(expected);
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
    // try/finally: a failing assertion between spyOn and mockRestore must not
    // leak the spy into later tests (BS#2071 review) — jest.clearAllMocks()
    // in beforeEach clears call history but does not undo an active spyOn.
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    try {
      queueDryRun(12, 0);

      await runResolve(true);

      const flowsheetCall = logSpy.mock.calls.find((call) => call[1] === 'resolve-flowsheet');
      expect(flowsheetCall?.[3]).toEqual(expect.objectContaining({ candidates: 12, resolved: 0, residual: null }));
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('legacy-linkage-resolve: lock guard (BS#2413)', () => {
  /**
   * BS#2413. `wxyc_schema.library_watermark` is a SINGLE-row table
   * (`CHECK (id = true)`, migration 0104) and nine `FOR EACH STATEMENT`
   * triggers rewrite that one row — including
   * `touch_library_watermark_from_rotation` (migration 0105) and the
   * `library` trigger itself. Any statement that fires one takes an
   * exclusive row lock on that row and holds it until COMMIT, so
   * `jobs/library-etl`'s single 13-15 minute import transaction blocks this
   * job's rotation UPDATE outright — and, because a statement-level trigger
   * fires even on `UPDATE 0`, blocks it whether or not the cohort is empty.
   *
   * Two levers land here, and they cover disjoint halves of the problem:
   *
   *   - the candidate pre-check (allowlisted above) keeps a pass with nothing
   *     to repair from issuing an UPDATE at all, so it never asks for the
   *     watermark row;
   *   - `SET LOCAL lock_timeout`, below the default 1 s `deadlock_timeout`,
   *     bounds the wait for the pass that DOES have work, turning a 300 s
   *     `statement_timeout` burn and a generic "Failed query" into a
   *     seconds-long stand-down with a lock-specific SQLSTATE.
   */
  it('bounds the lock wait below the default deadlock_timeout', () => {
    // Under 1000 ms on purpose. This job holds FOR KEY SHARE on `library`
    // rows (the `album_id` FK check) and wants the watermark row;
    // `library-etl` holds the watermark row and wants FOR UPDATE on `library`
    // rows — a real cycle. Giving up before the deadlock detector runs means
    // this job is always the side that stands down, never the reason
    // `library-etl` loses a quarter-hour transaction as the chosen victim.
    // Same reasoning, and the same value, as `DELETE_ALBUM_LOCK_TIMEOUT_MS`
    // in `apps/backend/services/library.service.ts`.
    expect(LINKAGE_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LINKAGE_LOCK_TIMEOUT_MS).toBeLessThan(1000);
  });

  it.each([['55P03' as const], ['40P01' as const]])(
    'stands down without throwing when the rotation CTE is rejected with %s',
    async (code) => {
      queueRun({ candidates: 0, resolved: 0 }, { candidates: 4, resolved: 0, defer: code });

      const result = await runOnce(false);

      expect(result.rotation.deferred).toBe(true);
      expect(result.rotation.resolved).toBe(0);
      // `residual: null`, not 0 — nothing was drained and nothing was
      // measured. A 0 here would read as "cohort is clear".
      expect(result.rotation.residual).toBeNull();
      expect(result.flowsheet.deferred).toBe(false);
    }
  );

  it('guards the flowsheet pass too, not only rotation', async () => {
    // The flowsheet pass survives in production on DATA, not on design.
    // `flowsheet` has no watermark trigger, but its UPDATE still takes
    // FOR KEY SHARE on each `library` row it links (the `album_id` FK check),
    // which can queue behind a FOR UPDATE `library-etl` holds on that row —
    // so the first non-empty flowsheet cohort landing on a `library-etl` work
    // slot reproduces the rotation failure, just by a narrower route.
    queueRun({ candidates: 6, resolved: 0, defer: '55P03' }, { candidates: 0, resolved: 0 });

    const result = await runOnce(false);

    expect(result.flowsheet.deferred).toBe(true);
    expect(result.rotation.deferred).toBe(false);
  });

  it('does not advance the cronjob_runs heartbeat on a stand-down', async () => {
    // A skipped slot is a new way for the repair to be deferred. Advancing
    // the heartbeat would make signal (b) read a run that repaired nothing as
    // a successful one, so a persistent collision would look healthy forever.
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 4, resolved: 0, defer: '55P03' });

    await runOnce(false);

    expect(updateLastRun).not.toHaveBeenCalled();
  });

  it('still records the heartbeat when both passes complete', async () => {
    queueRun({ candidates: 2, resolved: 2 }, { candidates: 1, resolved: 1 });

    await runOnce(false);

    expect(updateLastRun).toHaveBeenCalledTimes(1);
  });

  it('warns with a lock-specific Sentry message, never the drain warning', async () => {
    queueRun({ candidates: 0, resolved: 0 }, { candidates: 4, resolved: 0, defer: '55P03' });

    await runOnce(false);

    const messages = mockCaptureMessage.mock.calls.map((call) => call[0] as string);
    expect(messages).toEqual([`${JOB_NAME}.lock_contention`]);
    // `unresolved_candidates` asserts "the UPDATE did not resolve what it
    // found". A stand-down never ran the UPDATE, so claiming that would be a
    // report on a cohort this pass never looked at.
    expect(messages).not.toContain(`${JOB_NAME}.unresolved_candidates`);
    expect(mockCaptureMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ step: 'lock-rotation' }),
        extra: expect.objectContaining({ pass: 'rotation', candidates: 4 }),
      })
    );
  });

  it('lets a non-lock SQLSTATE propagate rather than swallowing it as a stand-down', async () => {
    // 57014 is `query_canceled` — the 300 s `statement_timeout` firing. If the
    // lock guard ever fails to bind, this is the error that comes back, and it
    // must stay a hard failure rather than being reported as a clean skip.
    // Wrapped, because that is the shape the job catches: reading the SQLSTATE
    // out of `.cause` must not become "any wrapped error is contention".
    const execute = db.execute as jest.Mock;
    execute.mockResolvedValueOnce([{ count: 0 }]); // flowsheet pre-check
    execute.mockResolvedValueOnce([{ count: 3 }]); // rotation pre-check
    execute.mockResolvedValueOnce([]); // SET LOCAL
    execute.mockRejectedValueOnce(drizzleWrapped(pgError('57014', 'canceling statement due to statement timeout')));

    await expect(runOnce(false)).rejects.toThrow('Failed query');
    expect(updateLastRun).not.toHaveBeenCalled();
  });

  it('stands down on a bare driver error too — the wrapper is preferred, not required', async () => {
    // The classifier reads `.cause.code` first and falls back to `.code`. The
    // fallback is what keeps a driver error that reaches the job unwrapped
    // (and every hand-built test double that models one) classifying the same
    // way as the wrapped production form.
    const execute = db.execute as jest.Mock;
    execute.mockResolvedValueOnce([{ count: 0 }]); // flowsheet pre-check
    execute.mockResolvedValueOnce([{ count: 4 }]); // rotation pre-check
    execute.mockResolvedValueOnce([]); // SET LOCAL
    execute.mockRejectedValueOnce(lockContentionError('55P03', 'bare'));

    const result = await runOnce(false);

    expect(result.rotation.deferred).toBe(true);
    expect(updateLastRun).not.toHaveBeenCalled();
  });

  it('does not mistake an unrelated wrapped error for lock contention', async () => {
    // `DrizzleQueryError.code` is always undefined, so the classifier can only
    // work off `.cause`. A wrapped FK violation must still be a hard failure.
    const execute = db.execute as jest.Mock;
    execute.mockResolvedValueOnce([{ count: 0 }]); // flowsheet pre-check
    execute.mockResolvedValueOnce([{ count: 2 }]); // rotation pre-check
    execute.mockResolvedValueOnce([]); // SET LOCAL
    execute.mockRejectedValueOnce(drizzleWrapped(pgError('23503', 'insert or update violates foreign key')));

    await expect(runOnce(false)).rejects.toThrow('Failed query');
    expect(updateLastRun).not.toHaveBeenCalled();
  });

  it('never feeds the pre-check count into the drain comparison (BS#2071 two-snapshot regression)', async () => {
    // The pre-check sees 5; the CTE's own single snapshot sees 3 and drains
    // all 3. That gap is the benign race BS#2071 exists to stop warning
    // about — two rows left the cohort between the two statements. Comparing
    // the pre-check's 5 against the CTE's 3 would resurrect exactly the false
    // positive BS#2071 removed, on a run that did everything right.
    queueRun({ candidates: 3, resolved: 3, precheck: 5 }, { candidates: 0, resolved: 0 });

    const result = await runOnce(false);

    expect(result.flowsheet).toEqual({ candidates: 3, resolved: 3, residual: 0, deferred: false });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('a dry run takes no transaction and sets no lock timeout', async () => {
    queueDryRun(7, 4);

    await runOnce(true);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(findSqlMatching(/lock_timeout/i)).toBeUndefined();
  });
});
