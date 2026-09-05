/**
 * Unit tests for station-signup-review/downgrade.ts -- the 30-day auto-
 * downgrade write path. Pins the two safety-critical invariants from the
 * epic (BS#2364): the 30-day boundary is exact (not off-by-one either
 * direction), and the write NEVER touches `auth_user.role` -- only
 * `auth_member.role`, and only when it currently holds `'dj'`.
 *
 * `db.update` is mocked per-table-identity so a call against the wrong table
 * object is detectable, mirroring the bespoke `jest.mock('@wxyc/database', ...)`
 * shape `tests/unit/jobs/metadata-no-match-digest/watermark.test.ts` uses for
 * the same reason: the shared `tests/mocks/database.mock.ts` chain can't
 * express a controllable per-call result.
 */
import { jest } from '@jest/globals';

const mockReturning = jest.fn<() => Promise<Array<{ id: string }>>>();
const mockWhere = jest.fn().mockReturnValue({ returning: mockReturning });
const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });

const fakeDb = { update: mockUpdate };

const USER_TABLE = { __table: 'auth_user' };
const MEMBER_TABLE = { __table: 'auth_member', userId: 'userId', role: 'role' };

jest.mock('@wxyc/database', () => ({
  db: fakeDb,
  user: USER_TABLE,
  member: MEMBER_TABLE,
}));

jest.mock('drizzle-orm', () => ({
  and: jest.fn((...args: unknown[]) => ({ and: args })),
  eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

import {
  DOWNGRADE_AFTER_DAYS,
  downgradeOverdueAccounts,
  isPastDowngradeCutoff,
} from '../../../../jobs/station-signup-review/downgrade';
import type { PendingSignupRow } from '../../../../jobs/station-signup-review/query';

const row = (overrides: Partial<PendingSignupRow> = {}): PendingSignupRow => ({
  userId: 'u1',
  name: 'Test DJ',
  email: 'testdj@example.com',
  djName: 'DJ Test',
  selfSignupAt: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
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

  it('is true exactly at the 30-day boundary', () => {
    const selfSignupAt = new Date('2026-07-01T00:00:00Z');
    const now = new Date(selfSignupAt.getTime() + THIRTY_DAYS_MS);
    expect(isPastDowngradeCutoff(selfSignupAt, now)).toBe(true);
  });

  it('is true well past the 30-day boundary', () => {
    const selfSignupAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-07-01T00:00:00Z');
    expect(isPastDowngradeCutoff(selfSignupAt, now)).toBe(true);
  });

  it('is false for an account signed up yesterday', () => {
    const now = new Date('2026-07-31T00:00:00Z');
    const selfSignupAt = new Date('2026-07-30T00:00:00Z');
    expect(isPastDowngradeCutoff(selfSignupAt, now)).toBe(false);
  });
});

describe('downgradeOverdueAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when no rows are past the 30-day cutoff', async () => {
    const now = new Date('2026-07-15T00:00:00Z');
    const rows = [row({ selfSignupAt: new Date('2026-07-01T00:00:00Z') })]; // 14 days pending

    const downgraded = await downgradeOverdueAccounts(fakeDb as never, rows, now);

    expect(downgraded).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('writes ONLY to the auth_member table, never auth_user, for an overdue account', async () => {
    const now = new Date('2026-08-01T00:00:00Z'); // 31 days after selfSignupAt
    const rows = [row()];
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    const downgraded = await downgradeOverdueAccounts(fakeDb as never, rows, now);

    expect(downgraded).toEqual([rows[0]]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(MEMBER_TABLE);
    expect(mockUpdate).not.toHaveBeenCalledWith(USER_TABLE);
    // The invariant this issue exists to pin: the SET clause only ever
    // touches auth_member.role, and never mentions auth_user in any form.
    expect(mockSet).toHaveBeenCalledWith({ role: 'member' });
  });

  it('scopes the UPDATE to the account and role=dj -- a member-role account is left alone', async () => {
    const now = new Date('2026-08-01T00:00:00Z');
    const rows = [row()];
    // returning([]) simulates the WHERE role='dj' guard matching zero rows
    // (the account was already 'member', e.g. downgraded by a prior run).
    mockReturning.mockResolvedValueOnce([]);

    const downgraded = await downgradeOverdueAccounts(fakeDb as never, rows, now);

    expect(downgraded).toEqual([]);
    expect(mockWhere).toHaveBeenCalledWith({
      and: [{ eq: [MEMBER_TABLE.userId, 'u1'] }, { eq: [MEMBER_TABLE.role, 'dj'] }],
    });
  });

  it('excludes already-reviewed accounts -- callers pass only unreviewed rows, so a reviewed row never reaches this function', async () => {
    // downgradeOverdueAccounts trusts its caller (query.ts) to have already
    // filtered to self_signup_reviewed_at IS NULL; this test documents that
    // contract by asserting the function has no independent review-state
    // check of its own to bypass -- passing a reviewed-looking row (there is
    // no reviewedAt field on PendingSignupRow) still downgrades on selfSignupAt
    // alone, which is correct ONLY because the caller's WHERE clause already
    // excluded reviewed accounts. See query.test.ts for that guarantee.
    const now = new Date('2026-08-01T00:00:00Z');
    const rows = [row()];
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]);

    await downgradeOverdueAccounts(fakeDb as never, rows, now);

    expect(mockUpdate).toHaveBeenCalledWith(MEMBER_TABLE);
  });

  it('processes multiple overdue accounts independently, downgrading only the ones whose UPDATE actually matched', async () => {
    const now = new Date('2026-08-01T00:00:00Z');
    const rows = [row({ userId: 'u1' }), row({ userId: 'u2' })];
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }]).mockResolvedValueOnce([]);

    const downgraded = await downgradeOverdueAccounts(fakeDb as never, rows, now);

    expect(downgraded).toEqual([rows[0]]);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});
