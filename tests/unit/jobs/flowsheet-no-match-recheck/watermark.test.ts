/**
 * Unit tests for jobs/flowsheet-no-match-recheck watermark.ts (BS#2218).
 *
 * Covers the OFFSET-cursor starvation guard:
 *   1. `getCursorPosition` / `setCursorPosition` — the `cronjob_runs.
 *      cursor_position` upsert idiom, mirroring
 *      `jobs/metadata-no-match-digest/watermark.ts`'s `getLastRun` /
 *      `updateLastRun` shape (same bespoke `jest.mock('@wxyc/database', ...)`
 *      for the same reason: the shared `tests/mocks/database.mock.ts` chain
 *      can't express a controllable "row exists" vs "no row" result from
 *      `.limit()`).
 *   2. `stillCandidates` / `nextCursorPosition` — the advance rule, and the
 *      acceptance criterion it exists to satisfy: a batch in which every
 *      candidate transients (leaving `no_match_recheck_attempted_at`
 *      untouched, so `query.ts`'s ordering alone would re-select the
 *      identical window) still advances by the full scanned count, because
 *      nothing left the candidate set. The complement matters just as much
 *      and is pinned here too: a batch that WAS disposed of must not
 *      advance, because those rows have left the set and the same offset
 *      now addresses rows the job has never read. Advancing by `scanned`
 *      there would skip a whole batch per run until the cursor wrapped —
 *      the "recent playcuts are months out" failure `query.ts`'s
 *      newest-first tiebreak exists to remove, one block down the ordering.
 *   3. `wrapCursor` — the pure modulo-wraparound arithmetic underneath. The
 *      wraparound is what stops a persistently-transient head from occupying
 *      every future run's window: the cursor cycles back through the WHOLE
 *      matching predicate (both the never-attempted tier and the TTL-expired
 *      tier `query.ts` already rotates), so a row's TTL rotation is never
 *      permanently skipped.
 *
 * BS#2222 adds two more, both of which the review of PR #2608 found wrong on
 * the first pass:
 *   4. `departedCandidates` / `headDeparturesBelowCursor` and the corrected
 *      advance — the head slice's departures remove ordering positions BELOW
 *      the tail cursor, so an advance computed from the tail totals alone
 *      steps over up to `HEAD_SLICE` never-read rows every run. The review's
 *      N=1000 counter-example is simulated at the bottom of this file against
 *      the real arithmetic.
 *   5. `headCursorWindow` / `nextHeadCursorPosition` — the head read's own
 *      small rotating cursor, which is the head's answer to the same
 *      starvation the tail cursor solves: a transient outcome leaves the
 *      marker untouched, so a bare `OFFSET 0` head read would re-ask the
 *      identical rows forever.
 */
import { jest } from '@jest/globals';

const mockLimit = jest.fn<() => Promise<Array<{ cursorPosition: number | null }>>>();
const mockOnConflictDoUpdate = jest.fn<(config: unknown) => Promise<undefined>>().mockResolvedValue(undefined);
const mockValues = jest.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
const mockInsert = jest.fn().mockReturnValue({ values: mockValues });
const mockWhere = jest.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
const mockSelect = jest.fn().mockReturnValue({ from: mockFrom });

const fakeDb = {
  select: mockSelect,
  insert: mockInsert,
};

jest.mock('@wxyc/database', () => ({
  db: fakeDb,
  cronjob_runs: { job_name: 'job_name', last_run: 'last_run', cursor_position: 'cursor_position' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

import type { Totals } from '../../../../jobs/flowsheet-no-match-recheck/orchestrate';
import {
  departedCandidates,
  getCursorPosition,
  headCursorWindow,
  headDeparturesBelowCursor,
  headRotationIsInert,
  headRotationWarrantsWarning,
  HEAD_CURSOR_JOB_NAME,
  JOB_NAME,
  nextCursorPosition,
  nextHeadCursorPosition,
  planCursorAdvance,
  setCursorPosition,
  stillCandidates,
  wrapCursor,
} from '../../../../jobs/flowsheet-no-match-recheck/watermark';

/** A zeroed `Totals` with the named buckets applied — keeps each case below to the counters it is actually about. */
const totalsOf = (overrides: Partial<Totals>): Totals => ({
  scanned: 0,
  resolved: 0,
  resolved_dry: 0,
  unresolved: 0,
  trust_rejected: 0,
  lml_error: 0,
  raced: 0,
  db_error: 0,
  ...overrides,
});

describe('getCursorPosition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the stored cursor_position when a cronjob_runs row exists', async () => {
    mockLimit.mockResolvedValueOnce([{ cursorPosition: 400 }]);

    const result = await getCursorPosition();

    expect(result).toBe(400);
    expect(mockFrom).toHaveBeenCalled();
  });

  it('returns null when no cronjob_runs row exists yet (first opt-in run)', async () => {
    mockLimit.mockResolvedValueOnce([]);

    const result = await getCursorPosition();

    expect(result).toBeNull();
  });

  it('returns null when the row exists but cursor_position is NULL (a job_name row another job already wrote)', async () => {
    mockLimit.mockResolvedValueOnce([{ cursorPosition: null }]);

    const result = await getCursorPosition();

    expect(result).toBeNull();
  });
});

describe('setCursorPosition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts cronjob_runs on job_name with the given cursor_position', async () => {
    await setCursorPosition(fakeDb as never, 600);

    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ job_name: JOB_NAME, cursor_position: 600 }));
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ cursor_position: 600 }) })
    );
  });

  it('stamps last_run on both the insert and the conflict path, so the row stays an honest cron-liveness heartbeat', async () => {
    // `cronjob_runs.last_run` is the fleet's liveness signal
    // (docs/ops-cron-scheduling.md, "Cron liveness (BS#2064)"). Writing only
    // `cursor_position` would let the column's `defaultNow()` freeze at
    // whichever run first created the row, so from the second run on the
    // table would claim this job stopped running.
    await setCursorPosition(fakeDb as never, 600);

    const inserted = mockValues.mock.calls[0]?.[0] as { last_run?: Date };
    const updated = (mockOnConflictDoUpdate.mock.calls[0]?.[0] as { set?: { last_run?: Date } })?.set;
    expect(inserted?.last_run).toBeInstanceOf(Date);
    expect(updated?.last_run).toBeInstanceOf(Date);
    expect(updated?.last_run).toEqual(inserted?.last_run);
  });

  it('JOB_NAME is the job-scoped cronjob_runs key, not shared with any other job', () => {
    expect(JOB_NAME).toBe('flowsheet-no-match-recheck');
  });

  it('BS#2222: the head cursor lives on its own sub-keyed row, so the tail cursor row is untouched', async () => {
    // `<job>:<sub-key>` is the idiom library-etl already uses for per-pass
    // watermarks. Two rows rather than a second column means no migration and
    // no change to what `cursor_position` means on JOB_NAME's own row.
    expect(HEAD_CURSOR_JOB_NAME).toBe('flowsheet-no-match-recheck:head');
    expect(HEAD_CURSOR_JOB_NAME.startsWith(`${JOB_NAME}:`)).toBe(true);
    // varchar(64) primary key -- a longer key would fail on INSERT.
    expect(HEAD_CURSOR_JOB_NAME.length).toBeLessThanOrEqual(64);

    await setCursorPosition(fakeDb as never, 40, HEAD_CURSOR_JOB_NAME);

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ job_name: HEAD_CURSOR_JOB_NAME, cursor_position: 40 })
    );
  });

  it('BS#2222: getCursorPosition reads the row it is asked for, defaulting to the tail cursor', async () => {
    mockLimit.mockResolvedValueOnce([{ cursorPosition: 40 }]);
    await getCursorPosition(HEAD_CURSOR_JOB_NAME);
    expect(mockWhere).toHaveBeenLastCalledWith({ eq: ['job_name', HEAD_CURSOR_JOB_NAME] });

    mockLimit.mockResolvedValueOnce([{ cursorPosition: 400 }]);
    await getCursorPosition();
    expect(mockWhere).toHaveBeenLastCalledWith({ eq: ['job_name', JOB_NAME] });
  });
});

describe('stillCandidates', () => {
  it('counts a row that transiented (marker untouched, still enriched_no_match) as still a candidate', () => {
    expect(stillCandidates(totalsOf({ scanned: 200, lml_error: 200 }))).toBe(200);
  });

  it('counts a row whose DB write failed as still a candidate -- its marker never got stamped either', () => {
    expect(stillCandidates(totalsOf({ scanned: 200, lml_error: 150, db_error: 50 }))).toBe(200);
  });

  it('excludes every bucket whose rows left the candidate set: resolved, marked no-match, trust-rejected, raced', () => {
    // `resolved` flips metadata_status off enriched_no_match; `unresolved`
    // and `trust_rejected` stamp no_match_recheck_attempted_at = now(), which
    // fails query.ts's TTL predicate; `raced` means another writer already
    // moved the row off that status.
    expect(
      stillCandidates(totalsOf({ scanned: 200, resolved: 50, unresolved: 80, trust_rejected: 40, raced: 30 }))
    ).toBe(0);
  });
});

describe('nextCursorPosition', () => {
  it('BS#2218 acceptance criterion: an all-transient batch does not re-select the identical candidate window next run', () => {
    // Every one of a 200-row batch transients -- nothing leaves the candidate
    // set, so the cursor advances by the full scanned count, landing a
    // DIFFERENT offset for the next run rather than the same one.
    const thisRunOffset = 0;
    const nextRunOffset = nextCursorPosition(thisRunOffset, totalsOf({ scanned: 200, lml_error: 200 }), 137340);

    expect(nextRunOffset).not.toBe(thisRunOffset);
    expect(nextRunOffset).toBe(200);
  });

  it('does NOT advance when the whole batch was disposed of -- those rows left the set, so the same offset now points at unread rows', () => {
    // The regression this rule exists to prevent: advancing by `scanned`
    // here would put the next run at offset 200 of a set that just lost its
    // first 200 entries, stepping clean over the 200 next-newest rows until
    // the cursor wrapped hundreds of runs later.
    expect(nextCursorPosition(0, totalsOf({ scanned: 200, resolved: 200 }), 137140)).toBe(0);
  });

  it('advances by exactly the leftovers on a mixed batch', () => {
    // 200 scanned, 180 disposed of, 20 still transient -- the 20 leftovers
    // now sit at offsets 0..19, so the next run starts at 20.
    const totals = totalsOf({ scanned: 200, resolved: 60, unresolved: 100, trust_rejected: 20, lml_error: 20 });
    expect(nextCursorPosition(0, totals, 137160)).toBe(20);
  });

  it("BS#2222: subtracts the head pass's below-cursor departures, which shrink the ordering AHEAD of the cursor", () => {
    // The whole 180-row tail window transiented, so the tail leftovers are
    // 180 -- but the head pass disposed of 20 rows at positions below the
    // cursor, pulling 20 unread rows back behind it. Advancing by 180 would
    // step over exactly those 20.
    const tail = totalsOf({ scanned: 180, lml_error: 180 });
    const head = totalsOf({ scanned: 20, resolved: 5, unresolved: 12, trust_rejected: 2, raced: 1 });
    expect(nextCursorPosition(160, tail, 137320, headDeparturesBelowCursor(head, 0))).toBe(320);
    // Without the correction (the shipped-then-reviewed shape) it lands 20 too far.
    expect(nextCursorPosition(160, tail, 137320)).toBe(340);
  });

  it('BS#2222: clamps at >= 0 so a head-heavy run cannot wrap a negative offset to the END of the cohort', () => {
    // A tail that disposed of everything (0 leftovers) plus 20 head
    // departures would compute -20; wrapping that into range would land the
    // next run near the last rows of the ordering and skip the entire
    // remainder of the traversal.
    const tail = totalsOf({ scanned: 180, resolved: 180 });
    const head = totalsOf({ scanned: 20, unresolved: 20 });
    expect(nextCursorPosition(0, tail, 137140, headDeparturesBelowCursor(head, 0))).toBe(0);
  });
});

describe('departedCandidates / headDeparturesBelowCursor (BS#2222)', () => {
  it('counts exactly the buckets whose rows left the candidate set', () => {
    expect(departedCandidates(totalsOf({ resolved: 5, unresolved: 12, trust_rejected: 2, raced: 1 }))).toBe(20);
    // Stayers and the dry-run-only bucket are never departures.
    expect(departedCandidates(totalsOf({ lml_error: 9, db_error: 3, resolved_dry: 7 }))).toBe(0);
  });

  it('excludes head rows the tail read also covered, because excludeCandidateIds already shrank tailTotals by them', () => {
    const head = totalsOf({ scanned: 20, unresolved: 20 });
    // Full overlap (the cursor sits inside the head window): the dedupe
    // already removed all 20 from the tail's scanned count, so subtracting
    // them again would under-advance into re-reading rows just read.
    expect(headDeparturesBelowCursor(head, 20)).toBe(0);
    // Partial overlap.
    expect(headDeparturesBelowCursor(head, 8)).toBe(12);
    // No overlap -- the ordinary steady state.
    expect(headDeparturesBelowCursor(head, 0)).toBe(20);
  });

  it('never goes negative when more head rows overlapped than departed', () => {
    const head = totalsOf({ scanned: 20, unresolved: 5, lml_error: 15 });
    expect(headDeparturesBelowCursor(head, 20)).toBe(0);
  });
});

describe('headCursorWindow / nextHeadCursorPosition (BS#2222)', () => {
  it('rotates by one head slice per run and cycles the whole window before repeating', () => {
    const window = 200;
    const headSlice = 20;
    const seen = new Set<number>();
    let offset = 0;
    for (let run = 0; run < window / headSlice; run++) {
      seen.add(offset);
      offset = nextHeadCursorPosition(offset, headSlice, window);
    }
    // 10 distinct head windows -- 2.5 days at 4 runs/day -- then back to 0.
    expect(seen.size).toBe(10);
    expect(offset).toBe(0);
  });

  it('acceptance criterion: an all-transient head window is NOT re-selected next run', () => {
    // The defect this exists for: a transient outcome deliberately leaves
    // `no_match_recheck_attempted_at` untouched (BS#1977 / BS#2179 review
    // HIGH 2), so those rows keep their ordering position. A bare OFFSET 0
    // head read would re-ask the identical 20 rows every run forever.
    expect(nextHeadCursorPosition(0, 20, 200)).not.toBe(0);
  });

  it('caps the window at the cohort size so a head offset never lands past the end of a small cohort', () => {
    expect(headCursorWindow(137340, 200)).toBe(200);
    expect(headCursorWindow(50, 200)).toBe(50);
    expect(headCursorWindow(0, 200)).toBe(0);
    // An empty cohort collapses the rotation to offset 0 rather than dividing by zero.
    expect(nextHeadCursorPosition(0, 20, headCursorWindow(0, 200))).toBe(0);
  });

  it('wraps a window that is not an exact multiple of the head slice instead of stepping past it', () => {
    // 30 does not divide 200: the offsets drift (…180 -> 10) rather than
    // repeating a fixed set, which still covers the window.
    expect(nextHeadCursorPosition(180, 30, 200)).toBe(10);
  });
});

describe("BS#2222 cursor-advance simulation (the review's N=1000 counter-example)", () => {
  const HEAD_SLICE = 20;
  const TAIL_BATCH = 180;

  /**
   * Walk the reviewer's scenario with the REAL arithmetic: 1000 candidate
   * rows, the head read at the front, head rows answered definitively (they
   * leave the candidate set) and tail rows transient (they stay). The head is
   * held at offset 0 here — its own first-run position, and the worst case for
   * the tail cursor, since that is where the head's departures do the most
   * damage to the positions the tail cursor counts.
   */
  const simulate = (runs: number) => {
    let rows = Array.from({ length: 1000 }, (_, index) => index);
    const read = new Set<number>();
    let cursor = 0;
    const cursorRows: number[] = [];

    for (let run = 0; run < runs; run++) {
      const headRows = rows.slice(0, HEAD_SLICE);
      const headIds = new Set(headRows);
      const tailWindow = rows.slice(cursor, cursor + TAIL_BATCH);
      const tailRows = tailWindow.filter((row) => !headIds.has(row));
      const overlap = tailWindow.length - tailRows.length;

      for (const row of [...headRows, ...tailRows]) read.add(row);

      const headTotals = totalsOf({ scanned: headRows.length, unresolved: headRows.length });
      const tailTotals = totalsOf({ scanned: tailRows.length, lml_error: tailRows.length });

      rows = rows.filter((row) => !headIds.has(row));
      cursor = nextCursorPosition(cursor, tailTotals, rows.length, headDeparturesBelowCursor(headTotals, overlap));
      cursorRows.push(rows[cursor] ?? -1);

      // The invariant: the cursor may never sit ahead of a row nobody read.
      expect(rows.slice(0, cursor).filter((row) => !read.has(row))).toEqual([]);
    }
    return { cursorRows, read };
  };

  it('lands run 1 exactly at r180 — the first row neither read covered', () => {
    expect(simulate(1).cursorRows[0]).toBe(180);
  });

  it('never steps over an unread row across five runs (the shipped shape skipped 20 per run from run 2 on)', () => {
    const { cursorRows } = simulate(5);
    // Each run reads 180 distinct positions, so the cursor advances exactly
    // one tail window per run: r180, r360, r540, r720, r900.
    expect(cursorRows).toEqual([180, 360, 540, 720, 900]);
  });
});

describe('wrapCursor', () => {
  it('wraps back to 0 once the offset reaches the total candidate count', () => {
    expect(wrapCursor(137340, 137340)).toBe(0);
  });

  it('wraps partway through when the advance overshoots the total (cursor cycles back near the start, not past it)', () => {
    // A stored cursor near the tail (137200) plus a full batch (200)
    // overshoots the 137340-row total by 60 -- the guarantee this exists
    // for: that overshoot is NOT lost, it wraps to the front of the
    // ordering, so TTL-expired rows sitting early in the list are still
    // reachable on the very next run instead of waiting for the cursor to
    // count all the way back up to their position.
    expect(wrapCursor(137200 + 200, 137340)).toBe(60);
  });

  it('returns 0 when there are no matching candidates at all (nothing to offset into)', () => {
    expect(wrapCursor(200, 0)).toBe(0);
  });

  it('is a no-op modulo for an offset already inside range', () => {
    expect(wrapCursor(50, 137340)).toBe(50);
  });

  it('full-cohort coverage: repeatedly advancing by batchSize eventually visits every offset in [0, total) before repeating', () => {
    const total = 1000;
    const batchSize = 200;
    const seen = new Set<number>();
    let offset = 0;
    // 1000 / 200 = 5 distinct windows before the cursor returns exactly to 0.
    for (let i = 0; i < 5; i++) {
      seen.add(offset);
      offset = wrapCursor(offset + batchSize, total);
    }
    expect(seen.size).toBe(5);
    expect(offset).toBe(0); // back to the start -- the cycle closed cleanly
  });
});

/**
 * BS#2222 review finding 1. `main`'s inline wiring was the only place the two
 * cursors were distinguished — which `Totals` feeds the tail advance, which
 * modulus the head wraps against, and which `cronjob_runs` row each is stamped
 * on — and `main` is unexported, so no test could reach any of it. The review's
 * mutation probe reintroduced BOTH defects the earlier iterations fixed (the
 * tail advancing on the MERGED totals; the head rotation written onto the tail's
 * row) with all 128 tests still green.
 *
 * These cases pin the wiring itself, not just its arithmetic: each one fails
 * under one of those two mutations.
 */
describe('planCursorAdvance (BS#2222 review finding 1)', () => {
  /** A run where head and tail differ in every respect, so a swap of either is visible. */
  const input = {
    tailCursorOffset: 1000,
    headCursorOffset: 60,
    tailTotals: totalsOf({ scanned: 180, resolved: 30 }),
    headTotals: totalsOf({ scanned: 20, resolved: 8 }),
    headRowsInTailWindow: 0,
    headSlice: 20,
    totalCandidates: 137340,
    headWindow: 200,
  };

  it('stamps the tail advance on the job row and the head rotation on the :head row, in that order', () => {
    const { writes } = planCursorAdvance(input);

    expect(writes.map((write) => write.jobName)).toEqual([JOB_NAME, HEAD_CURSOR_JOB_NAME]);
    // The head rotation must NOT land on the tail's row: doing so overwrites the
    // BS#2218 cursor with a value from a 200-row modulus every run, destroying
    // the traversal outright.
    expect(writes.find((write) => write.jobName === JOB_NAME)?.position).toBe(1142);
    expect(writes.find((write) => write.jobName === HEAD_CURSOR_JOB_NAME)?.position).toBe(80);
  });

  it('advances the tail on the TAIL totals alone, never the merged head+tail pair', () => {
    const { writes } = planCursorAdvance(input);
    const tail = writes.find((write) => write.jobName === JOB_NAME)?.position;

    // 1000 + stillCandidates(tail) - headDepartures = 1000 + (180 - 30) - 8.
    expect(tail).toBe(1142);
    // The mutation the review probe applied — the MERGED head+tail totals —
    // gives 1000 + (200 - 38) - 8 = 1154, stepping over 12 unread tail rows
    // every run. Named here so the difference is the assertion, not a coincidence.
    const merged = totalsOf({ scanned: 200, resolved: 38 });
    expect(nextCursorPosition(1000, merged, 137340, 8)).toBe(1154);
    expect(tail).not.toBe(1154);
  });

  it('wraps the head rotation against the head WINDOW, not the whole cohort', () => {
    // Offset 190 + slice 20 = 210, which must wrap inside the 200-row window to
    // 10. Against the 137,340-row cohort it would stay 210 and walk the head
    // cursor out of the recent window entirely.
    const { writes } = planCursorAdvance({ ...input, headCursorOffset: 190 });

    expect(writes.find((write) => write.jobName === HEAD_CURSOR_JOB_NAME)?.position).toBe(10);
  });

  it('reports each cursor under its own log key, so a swap is visible in the log line too', () => {
    const { logFields } = planCursorAdvance(input);

    expect(logFields).toEqual({
      cursor_offset: 1000,
      next_cursor: 1142,
      tail_scanned: 180,
      still_candidates: 150,
      head_departures_below_cursor: 8,
      head_rows_in_tail_window: 0,
      head_cursor_offset: 60,
      next_head_cursor: 80,
      head_cursor_window: 200,
      total_candidates: 137340,
    });
  });

  it('subtracts the head pass departures from the tail advance', () => {
    // 8 head rows left the cohort and none of them were also in the tail read,
    // so they removed 8 ordering positions below the cursor: 1000 + 150 - 8.
    const { writes } = planCursorAdvance({ ...input, headRowsInTailWindow: 0 });
    const withOverlap = planCursorAdvance({ ...input, headRowsInTailWindow: 8 });

    expect(writes.find((write) => write.jobName === JOB_NAME)?.position).toBe(1142);
    // With all 8 already deduped out of the tail read, `tailTotals.scanned` is
    // already 8 smaller, so subtracting again would double-count and under-
    // advance into re-reading. The correction clamps to 0 and the advance is
    // the full 150.
    expect(withOverlap.writes.find((write) => write.jobName === JOB_NAME)?.position).toBe(1150);
  });
});

/**
 * BS#2222 review finding 2: the half-batch clamp and the 200-row head window are
 * unrelated constants, so a config can pass the clamp and still leave the head
 * cursor standing still.
 */
describe('headRotationIsInert (BS#2222 review finding 2)', () => {
  it.each([
    ['head slice equal to the window', 200, 200],
    ['head slice a multiple of the window', 400, 200],
    ['a disabled head slice', 0, 200],
  ])('reports %s as inert', (_label, headSlice, window) => {
    expect(headRotationIsInert(headSlice, window)).toBe(true);
    // The defining symptom: the rotation returns the offset it was given.
    expect(nextHeadCursorPosition(37, headSlice, window)).toBe(37);
  });

  it.each([
    ['the default pairing', 20, 200],
    ['an exact divisor that still rotates', 100, 200],
    ['a slice wider than the window but not a multiple', 300, 200],
  ])('reports %s as rotating', (_label, headSlice, window) => {
    expect(headRotationIsInert(headSlice, window)).toBe(false);
    expect(nextHeadCursorPosition(37, headSlice, window)).not.toBe(37);
  });

  it('is false for an empty window, which wrapCursor already collapses to 0', () => {
    // An empty cohort is not a misconfiguration to warn about — there is
    // nothing to rotate through — so this must not fire on it.
    expect(headRotationIsInert(20, 0)).toBe(false);
  });

  it('the shipped default pairing covers the whole window rather than repeating a fixed set', () => {
    const window = 200;
    const headSlice = 20;
    const seen = new Set<number>();
    let offset = 0;
    for (let run = 0; run < window / headSlice; run++) {
      seen.add(offset);
      offset = nextHeadCursorPosition(offset, headSlice, window);
    }

    expect(seen.size).toBe(10);
    expect(offset).toBe(0);
  });
});

/**
 * `/code-review` on PR #2608: inertness alone is the wrong warning condition.
 * Two configurations reach it without being misconfigured, and warning on
 * either sends the operator to a knob that is not the problem.
 */
describe('headRotationWarrantsWarning (/code-review on PR #2608)', () => {
  const WINDOW_DEFAULT = 200;

  it('warns on the genuine case: a full-width window and a head slice that is a multiple of it', () => {
    // BATCH_SIZE=400 + HEAD_SLICE=200 passes the half-batch ceiling exactly.
    expect(headRotationWarrantsWarning(200, 200, WINDOW_DEFAULT)).toBe(true);
    expect(headRotationWarrantsWarning(400, 200, WINDOW_DEFAULT)).toBe(true);
  });

  it('does NOT warn for a disabled head slice, which head_slice_disabled already reports', () => {
    // `headSlice` 0 is inert by definition, but the inert warning's advice
    // ("the window is fully covered every run; lower HEAD_SLICE") is false
    // here — nothing is read — and names the wrong variable. Emitting both
    // gave one condition two contradictory remediations.
    expect(headRotationIsInert(0, 200)).toBe(true);
    expect(headRotationWarrantsWarning(0, 200, WINDOW_DEFAULT)).toBe(false);
  });

  it('does NOT warn when the window was cohort-clamped, where full coverage is the intended behaviour', () => {
    // A 40-row cohort clamps the window to 40 (headCursorWindow), and a head
    // slice covering all of it is correct at that size.
    const window = headCursorWindow(40, WINDOW_DEFAULT);
    expect(window).toBe(40);
    expect(headRotationIsInert(40, window)).toBe(true);
    expect(headRotationWarrantsWarning(40, window, WINDOW_DEFAULT)).toBe(false);
  });

  it('does not warn for the shipped defaults, or for any slice that actually rotates', () => {
    expect(headRotationWarrantsWarning(20, 200, WINDOW_DEFAULT)).toBe(false);
    expect(headRotationWarrantsWarning(100, 200, WINDOW_DEFAULT)).toBe(false);
    expect(headRotationWarrantsWarning(300, 200, WINDOW_DEFAULT)).toBe(false);
  });

  it('does not warn on an empty cohort, where the window is 0 and there is nothing to rotate through', () => {
    expect(headRotationWarrantsWarning(20, headCursorWindow(0, WINDOW_DEFAULT), WINDOW_DEFAULT)).toBe(false);
  });
});
