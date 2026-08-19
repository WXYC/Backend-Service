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
  getCursorPosition,
  JOB_NAME,
  nextCursorPosition,
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
