/**
 * Unit tests for metadata-no-match-digest/watermark.ts.
 *
 * Covers the three watermark behaviors called out in the plan:
 *   1. First run (no cronjob_runs row) bounds the window to the last 24h
 *      instead of dumping full flowsheet history.
 *   2. The watermark advances (cronjob_runs.last_run upserted to runStart)
 *      when the caller reports the run succeeded (a send, or a 0-row run).
 *   3. The watermark does NOT advance when the caller reports a send
 *      failure -- the next run must retry the same window.
 *
 * `getLastRun`/`updateLastRun` follow the library-etl upsert idiom (a
 * drizzle query-builder chain against `cronjob_runs`, not raw SQL) --
 * mirrored here with the same bespoke `jest.mock('@wxyc/database', ...)`
 * shape `tests/unit/jobs/library-etl.test.ts` uses, because the repo's
 * default shared mock (`tests/mocks/database.mock.ts`) returns its chain
 * object (not a resolved value) from `.limit()`/`.where()`, which can't
 * express a controllable "row exists" vs "no row" result.
 */
import { jest } from '@jest/globals';

const mockLimit = jest.fn<() => Promise<Array<{ lastRun: Date }>>>();
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

// `requirePositiveInt` is re-exported from its pure source module (not
// jest.requireActual('@wxyc/database'), which would pull in the real DB
// client) -- same approach as the shared `tests/mocks/database.mock.ts`.
jest.mock('@wxyc/database', () => ({
  db: fakeDb,
  cronjob_runs: { job_name: 'job_name', last_run: 'last_run' },
  requirePositiveInt: jest.requireActual('../../../../shared/database/src/env-parsers.js').requirePositiveInt,
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

import {
  advanceWatermarkIfSuccessful,
  DIGEST_MAX_PLAY_AGE_HOURS_DEFAULT,
  FIRST_RUN_WINDOW_HOURS,
  getLastRun,
  resolvePlayAgeCutoff,
  resolveWindowStart,
  updateLastRun,
} from '../../../../jobs/metadata-no-match-digest/watermark';

describe('resolveWindowStart', () => {
  const runStart = new Date('2026-07-31T15:07:00Z');

  it('bounds the window to the last 24h on first run (no prior watermark)', () => {
    const windowStart = resolveWindowStart(null, runStart);
    expect(windowStart.getTime()).toBe(runStart.getTime() - FIRST_RUN_WINDOW_HOURS * 60 * 60 * 1000);
  });

  it('uses the prior watermark verbatim when one exists', () => {
    const lastRun = new Date('2026-07-30T15:07:00Z');
    expect(resolveWindowStart(lastRun, runStart)).toBe(lastRun);
  });

  it('FIRST_RUN_WINDOW_HOURS is one cadence period (24h)', () => {
    expect(FIRST_RUN_WINDOW_HOURS).toBe(24);
  });
});

describe('resolvePlayAgeCutoff', () => {
  const runStart = new Date('2026-07-31T15:07:00Z');

  it('defaults to DIGEST_MAX_PLAY_AGE_HOURS_DEFAULT (48h) when the env var is unset', () => {
    const cutoff = resolvePlayAgeCutoff(runStart, undefined);
    expect(DIGEST_MAX_PLAY_AGE_HOURS_DEFAULT).toBe(48);
    expect(cutoff.getTime()).toBe(runStart.getTime() - DIGEST_MAX_PLAY_AGE_HOURS_DEFAULT * 60 * 60 * 1000);
  });

  it('honors a DIGEST_MAX_PLAY_AGE_HOURS env override', () => {
    const cutoff = resolvePlayAgeCutoff(runStart, '12');
    expect(cutoff.getTime()).toBe(runStart.getTime() - 12 * 60 * 60 * 1000);
  });

  it('rejects 0 -- a blackhole setting, unlike BACKFILL_RECOVERY_WINDOW_HOURS where 0 disables the ceiling', () => {
    expect(() => resolvePlayAgeCutoff(runStart, '0')).toThrow(/DIGEST_MAX_PLAY_AGE_HOURS/);
  });

  it('rejects a non-numeric value', () => {
    expect(() => resolvePlayAgeCutoff(runStart, 'not-a-number')).toThrow(/DIGEST_MAX_PLAY_AGE_HOURS/);
  });

  it('rejects a negative value', () => {
    expect(() => resolvePlayAgeCutoff(runStart, '-5')).toThrow(/DIGEST_MAX_PLAY_AGE_HOURS/);
  });
});

describe('getLastRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the stored last_run Date when a cronjob_runs row exists', async () => {
    const lastRun = new Date('2026-07-30T15:07:00Z');
    mockLimit.mockResolvedValueOnce([{ lastRun }]);

    const result = await getLastRun('metadata-no-match-digest');

    expect(result).toBe(lastRun);
    expect(mockFrom).toHaveBeenCalled();
  });

  it('returns null when no cronjob_runs row exists yet (first run)', async () => {
    mockLimit.mockResolvedValueOnce([]);

    const result = await getLastRun('metadata-no-match-digest');

    expect(result).toBeNull();
  });
});

describe('updateLastRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts cronjob_runs on job_name with the given last_run', async () => {
    const ts = new Date('2026-07-31T15:07:00Z');

    await updateLastRun(fakeDb as never, 'metadata-no-match-digest', ts);

    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith({ job_name: 'metadata-no-match-digest', last_run: ts });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: { last_run: ts } }));
  });
});

describe('advanceWatermarkIfSuccessful', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('advances the watermark (calls updateLastRun) when the run succeeded', async () => {
    const runStart = new Date('2026-07-31T15:07:00Z');

    const advanced = await advanceWatermarkIfSuccessful(fakeDb as never, 'metadata-no-match-digest', runStart, true);

    expect(advanced).toBe(true);
    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith({ job_name: 'metadata-no-match-digest', last_run: runStart });
  });

  it('does NOT advance the watermark when the run failed (e.g. digest send failed)', async () => {
    const runStart = new Date('2026-07-31T15:07:00Z');

    const advanced = await advanceWatermarkIfSuccessful(fakeDb as never, 'metadata-no-match-digest', runStart, false);

    expect(advanced).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
