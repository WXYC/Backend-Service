/**
 * Unit tests for station-signup-review/downgrade.ts -- the 30-day auto-
 * downgrade plan/apply pair. Pins the safety-critical invariants from the
 * epic (BS#2364):
 *
 *   - the 30-day boundary is exact (not off-by-one either direction);
 *   - the write NEVER touches `auth_user.role` -- only `auth_member.role`,
 *     and only when it currently holds `'dj'`. The one `auth_user` column it
 *     is allowed to write is `self_signup_downgraded_at`;
 *   - the terminal marker makes the actuator fire at most once per account,
 *     so a manager's re-promotion is not undone the next morning;
 *   - every guard fails toward "wait": kill switch off, DJ on air, or the
 *     guard query itself throwing all defer rather than downgrade.
 *
 * `db` is mocked per-table-identity so a call against the wrong table object
 * is detectable, mirroring the bespoke `jest.mock('@wxyc/database', ...)`
 * shape `tests/unit/jobs/metadata-no-match-digest/watermark.test.ts` uses for
 * the same reason: the shared `tests/mocks/database.mock.ts` chain can't
 * express a controllable per-call result.
 */
import { jest } from '@jest/globals';

// --- auth_member / auth_user UPDATE chain (inside the transaction) ---------
const mockReturning = jest.fn<() => Promise<Array<{ id: string }>>>();
const mockMemberWhere = jest.fn<(clause: unknown) => unknown>().mockReturnValue({ returning: mockReturning });
const mockUserWhere = jest.fn<(clause: unknown) => Promise<unknown>>().mockResolvedValue(undefined);
const mockSet = jest.fn<(values: Record<string, unknown>) => unknown>();
const mockUpdate = jest.fn<(table: unknown) => unknown>();

// --- SELECT chain (holdsDjRole / hasOpenShow) -----------------------------
/** Queue of results, one per `.limit()` call, so each read can be steered independently. */
let selectResults: Array<unknown[] | Error> = [];
const mockLimit = jest.fn(() => {
  const next = selectResults.shift() ?? [];
  const rows: Promise<unknown[]> = next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  // The guard SELECTs await `.limit()` directly; the apply re-check chains
  // `.for('update')` onto it. Both resolve to the same queued result.
  return Object.assign(rows, { for: () => rows });
});
const mockSelectWhere = jest.fn<(clause: unknown) => unknown>().mockReturnValue({ limit: mockLimit });
const mockFrom = jest.fn<(table: unknown) => unknown>().mockReturnValue({ where: mockSelectWhere });
const mockSelect = jest.fn<(cols: unknown) => unknown>().mockReturnValue({ from: mockFrom });

const mockTransaction = jest.fn(async (fn: (tx: unknown) => Promise<boolean>) => fn(fakeDb));

const fakeDb: Record<string, unknown> = {
  update: mockUpdate,
  select: mockSelect,
  transaction: mockTransaction,
};

const USER_TABLE = {
  __table: 'auth_user',
  id: 'id',
  selfSignupReviewedAt: 'self_signup_reviewed_at',
  selfSignupDowngradedAt: 'self_signup_downgraded_at',
};
const MEMBER_TABLE = { __table: 'auth_member', id: 'id', userId: 'userId', role: 'role' };
const SHOWS_TABLE = { __table: 'shows', id: 'id', end_time: 'end_time', primary_dj_id: 'primary_dj_id' };
const SHOW_DJS_TABLE = { __table: 'show_djs', show_id: 'show_id', dj_id: 'dj_id' };

jest.mock('@wxyc/database', () => ({
  db: fakeDb,
  user: USER_TABLE,
  member: MEMBER_TABLE,
  shows: SHOWS_TABLE,
  show_djs: SHOW_DJS_TABLE,
}));

jest.mock('drizzle-orm', () => ({
  and: jest.fn((...args: unknown[]) => ({ and: args })),
  or: jest.fn((...args: unknown[]) => ({ or: args })),
  eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  isNull: jest.fn((col: unknown) => ({ isNull: col })),
  exists: jest.fn((sub: unknown) => ({ exists: sub })),
}));

import {
  DOWNGRADE_AFTER_DAYS,
  applyDowngrades,
  isDowngradeEnabled,
  isPastDowngradeCutoff,
  planDowngrades,
} from '../../../../jobs/station-signup-review/downgrade';
import type { DowngradeDecision } from '../../../../jobs/station-signup-review/downgrade';
import type { PendingSignupRow } from '../../../../jobs/station-signup-review/query';

const row = (overrides: Partial<PendingSignupRow> = {}): PendingSignupRow => ({
  userId: 'u1',
  name: 'Test DJ',
  email: 'testdj@example.com',
  djName: 'DJ Test',
  selfSignupAt: new Date('2026-07-01T00:00:00Z'),
  selfSignupDowngradedAt: null,
  ...overrides,
});

const OVERDUE_NOW = new Date('2026-08-01T00:00:00Z'); // 31 days after the default selfSignupAt

/** Steer the two guard SELECTs: `holdsDjRole` first, then `hasOpenShow`. */
const guards = ({ isDj = true, onAir = false }: { isDj?: boolean; onAir?: boolean } = {}): void => {
  selectResults = [isDj ? [{ id: 'm1' }] : [], onAir ? [{ id: 42 }] : []];
};

beforeEach(() => {
  jest.clearAllMocks();
  selectResults = [];
  process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'true';
  // Rebuild the chain terminals `clearAllMocks` just reset.
  mockMemberWhere.mockReturnValue({ returning: mockReturning });
  mockUserWhere.mockResolvedValue(undefined);
  mockSet.mockImplementation((values: Record<string, unknown>) =>
    'role' in values ? { where: mockMemberWhere } : { where: mockUserWhere }
  );
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSelectWhere.mockReturnValue({ limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<boolean>) => fn(fakeDb));
});

afterEach(() => {
  delete process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
});

describe('DOWNGRADE_AFTER_DAYS', () => {
  it('is 30 -- long enough to clear any holiday break (see plan rationale)', () => {
    expect(DOWNGRADE_AFTER_DAYS).toBe(30);
  });
});

describe('isPastDowngradeCutoff', () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  it('is false one millisecond before the 30-day boundary', () => {
    const selfSignupAt = new Date('2026-07-01T00:00:00Z');
    const now = new Date(selfSignupAt.getTime() + THIRTY_DAYS_MS - 1);
    expect(isPastDowngradeCutoff(selfSignupAt, now)).toBe(false);
  });

  it('is true exactly at the 30-day boundary -- the issue says "fires at 30 days", not "after"', () => {
    const selfSignupAt = new Date('2026-07-01T00:00:00Z');
    const now = new Date(selfSignupAt.getTime() + THIRTY_DAYS_MS);
    expect(isPastDowngradeCutoff(selfSignupAt, now)).toBe(true);
  });

  it('is true well past the 30-day boundary', () => {
    expect(isPastDowngradeCutoff(new Date('2026-01-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'))).toBe(true);
  });

  it('is false for an account signed up yesterday', () => {
    expect(isPastDowngradeCutoff(new Date('2026-07-30T00:00:00Z'), new Date('2026-07-31T00:00:00Z'))).toBe(false);
  });
});

describe('isDowngradeEnabled', () => {
  it('is false when STATION_SIGNUP_DOWNGRADE_ENABLED is unset -- the switch ships OFF', () => {
    delete process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
    expect(isDowngradeEnabled()).toBe(false);
  });

  it.each(['1', 'TRUE', 'True', 'yes', 'on', ' true'])(
    'is false for the near-miss value %p -- strict === "true", like DONATE_ENABLED',
    (value) => {
      process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = value;
      expect(isDowngradeEnabled()).toBe(false);
    }
  );

  it('is true only for the exact lowercase string', () => {
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'true';
    expect(isDowngradeEnabled()).toBe(true);
  });
});

describe('planDowngrades', () => {
  it('writes nothing at all -- planning is a pure decision phase', async () => {
    guards();
    await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns `pending` with no read at all for an account inside the 30-day window', async () => {
    const decisions = await planDowngrades(fakeDb as never, [row()], new Date('2026-07-15T00:00:00Z'));
    expect(decisions).toEqual([{ row: expect.anything(), status: 'pending', downgradedAt: null }]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns `already-downgraded` for a row already carrying the terminal marker, and never re-fires', async () => {
    const marker = new Date('2026-07-05T00:00:00Z');
    const decisions = await planDowngrades(
      fakeDb as never,
      [row({ selfSignupAt: new Date('2026-05-01T00:00:00Z'), selfSignupDowngradedAt: marker })],
      OVERDUE_NOW
    );

    expect(decisions[0].status).toBe('already-downgraded');
    expect(decisions[0].downgradedAt).toBe(marker);
    // The marker short-circuits before any guard read: this account is done.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns `downgrade-disabled` for an overdue account when the kill switch is off, and reads nothing', async () => {
    delete process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
    const decisions = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    expect(decisions[0].status).toBe('downgrade-disabled');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns `already-member` when the account no longer holds auth_member.role = dj', async () => {
    guards({ isDj: false });
    const decisions = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    expect(decisions[0].status).toBe('already-member');
    // The `shows` probe is skipped: a non-dj needs no downgrade, so whether
    // they are on air is moot.
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('defers an overdue DJ holding an open show -- a demoted DJ cannot POST /flowsheet/end', async () => {
    guards({ isDj: true, onAir: true });
    const decisions = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    expect(decisions[0]).toMatchObject({ status: 'deferred-on-air', deferReason: 'open-show', downgradedAt: null });
  });

  it('defers rather than downgrades when the on-air guard query itself throws (fail toward wait)', async () => {
    selectResults = [[{ id: 'm1' }], new Error('connection reset')];
    const decisions = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    expect(decisions[0]).toMatchObject({ status: 'deferred-on-air', deferReason: 'guard-error' });
  });

  it('defers rather than downgrades when the role lookup itself throws', async () => {
    selectResults = [new Error('connection reset')];
    const decisions = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    expect(decisions[0]).toMatchObject({ status: 'deferred-on-air', deferReason: 'guard-error' });
  });

  it('plans a downgrade for an overdue, enabled, off-air dj, stamped with `now`', async () => {
    guards();
    const decisions = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    expect(decisions[0].status).toBe('downgraded');
    expect(decisions[0].downgradedAt).toBe(OVERDUE_NOW);
  });

  it('filters the open-show probe on end_time IS NULL and either dj linkage', async () => {
    guards();
    await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);

    // Three `.where()` calls in order: the auth_member role lookup, the
    // `show_djs` EXISTS subquery, then the outer `shows` filter.
    expect(mockSelectWhere).toHaveBeenCalledTimes(3);
    expect(mockSelectWhere.mock.calls[1][0]).toEqual({
      and: [{ eq: [SHOW_DJS_TABLE.show_id, SHOWS_TABLE.id] }, { eq: [SHOW_DJS_TABLE.dj_id, 'u1'] }],
    });
    const showsWhere = mockSelectWhere.mock.calls[2][0];
    expect(showsWhere).toEqual({
      and: [
        { isNull: SHOWS_TABLE.end_time },
        { or: [{ eq: [SHOWS_TABLE.primary_dj_id, 'u1'] }, { exists: expect.anything() }] },
      ],
    });
  });

  it('returns one decision per row, in input order, for a mixed cohort', async () => {
    // u1: inside the window. u2: already marked. u3: overdue and downgradable.
    selectResults = [[{ id: 'm3' }], []];
    const decisions = await planDowngrades(
      fakeDb as never,
      [
        row({ userId: 'u1', selfSignupAt: new Date('2026-07-25T00:00:00Z') }),
        row({ userId: 'u2', selfSignupDowngradedAt: new Date('2026-07-10T00:00:00Z') }),
        row({ userId: 'u3' }),
      ],
      OVERDUE_NOW
    );

    expect(decisions.map((d) => [d.row.userId, d.status])).toEqual([
      ['u1', 'pending'],
      ['u2', 'already-downgraded'],
      ['u3', 'downgraded'],
    ]);
  });
});

describe('applyDowngrades', () => {
  const plannedFor = (r: PendingSignupRow): DowngradeDecision => ({
    row: r,
    status: 'downgraded',
    downgradedAt: OVERDUE_NOW,
  });

  /** Steer the in-transaction re-check: still-pending, i.e. neither reviewed nor already downgraded. */
  const stillPending = (): void => {
    selectResults.push([{ id: 'u1' }]);
  };

  it('re-checks self_signup_reviewed_at and self_signup_downgraded_at before touching anything', async () => {
    stillPending();
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(mockSelectWhere).toHaveBeenCalledWith({
      and: [
        { eq: [USER_TABLE.id, 'u1'] },
        { isNull: USER_TABLE.selfSignupReviewedAt },
        { isNull: USER_TABLE.selfSignupDowngradedAt },
      ],
    });
  });

  it('aborts as raced -- no role flip, no marker -- when a review landed between plan and apply', async () => {
    // The re-check finds the account no longer pending: a manager reviewed it
    // during the notify window.
    selectResults.push([]);

    const result = await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(result.downgraded).toEqual([]);
    expect(result.raced).toEqual([expect.objectContaining({ userId: 'u1' })]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('aborts as raced when a concurrent run already stamped the downgrade marker', async () => {
    // Same re-check, different real-world cause: a competing run of this job
    // downgraded the account first. Either way the row comes back empty.
    selectResults.push([]);

    const result = await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(result.raced).toEqual([expect.objectContaining({ userId: 'u1' })]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('writes ONLY auth_member.role and auth_user.self_signup_downgraded_at -- never auth_user.role', async () => {
    stillPending();
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    const result = await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(result.downgraded).toEqual([expect.objectContaining({ userId: 'u1' })]);
    expect(mockUpdate).toHaveBeenCalledWith(MEMBER_TABLE);
    expect(mockUpdate).toHaveBeenCalledWith(USER_TABLE);
    // The invariant this issue exists to pin. The auth_member SET clause only
    // ever touches `role`; the auth_user SET clause only ever touches the
    // marker, and mentions `role`/`banned` in no form whatsoever.
    expect(mockSet).toHaveBeenCalledWith({ role: 'member' });
    expect(mockSet).toHaveBeenCalledWith({ selfSignupDowngradedAt: OVERDUE_NOW });
    for (const [values] of mockSet.mock.calls) {
      expect(Object.keys(values)).toHaveLength(1);
    }
    const userSetCall = mockSet.mock.calls.find(([values]) => !('role' in values));
    expect(userSetCall?.[0]).not.toHaveProperty('role');
    expect(userSetCall?.[0]).not.toHaveProperty('banned');
  });

  it('puts the role flip and the marker stamp in ONE transaction -- half the pair is a defect either way', async () => {
    stillPending();
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('scopes the auth_member UPDATE to the account AND role=dj', async () => {
    stillPending();
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(mockMemberWhere).toHaveBeenCalledWith({
      and: [{ eq: [MEMBER_TABLE.userId, 'u1'] }, { eq: [MEMBER_TABLE.role, 'dj'] }],
    });
  });

  it('stamps the marker only where it is still NULL, so a re-run cannot rewrite the original date', async () => {
    stillPending();
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(mockUserWhere).toHaveBeenCalledWith({
      and: [{ eq: [USER_TABLE.id, 'u1'] }, { isNull: USER_TABLE.selfSignupDowngradedAt }],
    });
  });

  it('reports a raced account and stamps NO marker when the role guard matched nothing', async () => {
    // The re-check passes -- still pending -- but the account left `dj`
    // between the plan and the write.
    stillPending();
    mockReturning.mockResolvedValueOnce([]);

    const result = await applyDowngrades(fakeDb as never, [plannedFor(row())], OVERDUE_NOW);

    expect(result.downgraded).toEqual([]);
    expect(result.raced).toEqual([expect.objectContaining({ userId: 'u1' })]);
    expect(mockUpdate).not.toHaveBeenCalledWith(USER_TABLE);
  });

  it.each(['pending', 'already-downgraded', 'deferred-on-air', 'downgrade-disabled', 'already-member'] as const)(
    'writes nothing for a %s decision',
    async (status) => {
      const result = await applyDowngrades(fakeDb as never, [{ row: row(), status, downgradedAt: null }], OVERDUE_NOW);

      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(result.downgraded).toEqual([]);
    }
  );

  it('isolates a per-account failure so the rest of the cohort still gets written', async () => {
    mockTransaction
      .mockImplementationOnce(() => Promise.reject(new Error('deadlock detected')))
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<boolean>) => fn(fakeDb));
    stillPending();
    mockReturning.mockResolvedValueOnce([{ id: 'm2' }]);

    const result = await applyDowngrades(
      fakeDb as never,
      [plannedFor(row({ userId: 'u1' })), plannedFor(row({ userId: 'u2' }))],
      OVERDUE_NOW
    );

    expect(result.failed.map((f) => f.row.userId)).toEqual(['u1']);
    expect(result.downgraded.map((r) => r.userId)).toEqual(['u2']);
  });
});

describe('the re-fire loop this change exists to close', () => {
  it('does not re-downgrade a manager-re-promoted account, because the marker survives the role edit', async () => {
    // Day 1: overdue, unreviewed, still a dj -> downgraded, marker stamped.
    guards();
    const dayOne = await planDowngrades(fakeDb as never, [row()], OVERDUE_NOW);
    expect(dayOne[0].status).toBe('downgraded');

    // The manager promotes the account back to `dj` in the roster. That edit
    // touches auth_member.role only -- self_signup_downgraded_at persists, and
    // self_signup_reviewed_at is still NULL, so the row is still in the cohort.
    const rePromoted = row({ selfSignupDowngradedAt: OVERDUE_NOW });

    // Day 2: same overdue row, same `role = 'dj'`, and yet nothing fires.
    guards();
    const dayTwo = await planDowngrades(fakeDb as never, [rePromoted], new Date('2026-08-02T00:00:00Z'));
    expect(dayTwo[0].status).toBe('already-downgraded');

    const applied = await applyDowngrades(fakeDb as never, dayTwo, new Date('2026-08-02T00:00:00Z'));
    expect(applied.downgraded).toEqual([]);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
