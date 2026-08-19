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
 *   2. `wrapCursor` — the pure modulo-wraparound arithmetic. The acceptance
 *      criterion this exists to satisfy: a batch in which every candidate
 *      transients (leaving `no_match_recheck_attempted_at` untouched, so
 *      `query.ts`'s ordering alone would re-select the identical window)
 *      still advances the cursor, because the advance amount is
 *      `RunResult.totals.scanned` — incremented for every candidate
 *      regardless of outcome (see `orchestrate.ts`) — not a count of
 *      resolved/marked rows. And the wraparound guarantees a persistently-
 *      transient head can't occupy every future run's window forever: the
 *      cursor cycles back through the WHOLE matching predicate (both the
 *      never-attempted tier and the TTL-expired tier `query.ts` already
 *      rotates), so a row's TTL rotation is never permanently skipped.
 */
import { jest } from '@jest/globals';

const mockLimit = jest.fn<() => Promise<Array<{ cursorPosition: number | null }>>>();
const mockOnConflictDoUpdate = jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined);
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

import {
  getCursorPosition,
  JOB_NAME,
  setCursorPosition,
  wrapCursor,
} from '../../../../jobs/flowsheet-no-match-recheck/watermark';

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
    expect(mockValues).toHaveBeenCalledWith({ job_name: JOB_NAME, cursor_position: 600 });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: { cursor_position: 600 } }));
  });

  it('JOB_NAME is the job-scoped cronjob_runs key, not shared with any other job', () => {
    expect(JOB_NAME).toBe('flowsheet-no-match-recheck');
  });
});

describe('wrapCursor', () => {
  it('BS#2218 acceptance criterion: an all-transient batch does not re-select the identical candidate window next run', () => {
    // Every one of a 200-row batch transients (scanned=200, none marked) --
    // the cursor still advances by the full scanned count, landing a
    // DIFFERENT offset for the next run rather than the same one.
    const thisRunOffset = 0;
    const nextRunOffset = wrapCursor(thisRunOffset + 200, 137340);

    expect(nextRunOffset).not.toBe(thisRunOffset);
    expect(nextRunOffset).toBe(200);
  });

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
