/**
 * Unit tests for station-signup-review/query.ts. Pins the pending-review
 * predicate (self_signup_at IS NOT NULL AND self_signup_reviewed_at IS
 * NULL) and the null-filtering that satisfies the TS-level non-null
 * `PendingSignupRow.selfSignupAt` contract.
 *
 * Mirrors the bespoke `jest.mock('@wxyc/database', ...)` shape used by
 * `tests/unit/jobs/metadata-no-match-digest/watermark.test.ts` -- the shared
 * `tests/mocks/database.mock.ts` chain can't express a controllable
 * resolved value for `.where()`.
 */
import { jest } from '@jest/globals';

const mockWhere = jest.fn<() => Promise<unknown[]>>();
const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
const mockSelect = jest.fn().mockReturnValue({ from: mockFrom });

const fakeDb = { select: mockSelect };

const USER_TABLE = {
  id: 'id',
  name: 'name',
  email: 'email',
  djName: 'dj_name',
  selfSignupAt: 'self_signup_at',
  selfSignupReviewedAt: 'self_signup_reviewed_at',
  selfSignupDowngradedAt: 'self_signup_downgraded_at',
};

jest.mock('@wxyc/database', () => ({
  db: fakeDb,
  user: USER_TABLE,
}));

jest.mock('drizzle-orm', () => ({
  and: jest.fn((...args: unknown[]) => ({ and: args })),
  isNotNull: jest.fn((col: unknown) => ({ isNotNull: col })),
  isNull: jest.fn((col: unknown) => ({ isNull: col })),
}));

import { queryPendingSelfSignups } from '../../../../jobs/station-signup-review/query';

describe('queryPendingSelfSignups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters on self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL', async () => {
    mockWhere.mockResolvedValueOnce([]);

    await queryPendingSelfSignups();

    expect(mockWhere).toHaveBeenCalledWith({
      and: [{ isNotNull: USER_TABLE.selfSignupAt }, { isNull: USER_TABLE.selfSignupReviewedAt }],
    });
  });

  it('selects self_signup_downgraded_at but deliberately does NOT filter on it', async () => {
    // This is the DIGEST's cohort, and the same one dj-site's roster review
    // queue shows. Narrowing it by the downgrade marker would make an account
    // vanish from the digest the morning after it was downgraded — silently,
    // and exactly when a human most needs to see it. Only downgrade.ts's
    // actuator narrows by the marker.
    mockWhere.mockResolvedValueOnce([]);

    await queryPendingSelfSignups();

    expect(mockSelect).toHaveBeenCalledWith(
      expect.objectContaining({ selfSignupDowngradedAt: USER_TABLE.selfSignupDowngradedAt })
    );
    // Exactly two clauses, neither of them the marker.
    expect(mockWhere).toHaveBeenCalledWith({
      and: [{ isNotNull: USER_TABLE.selfSignupAt }, { isNull: USER_TABLE.selfSignupReviewedAt }],
    });
  });

  it('maps rows to PendingSignupRow, preserving all fields', async () => {
    const selfSignupAt = new Date('2026-07-01T00:00:00Z');
    mockWhere.mockResolvedValueOnce([
      {
        userId: 'u1',
        name: 'Test DJ',
        email: 'testdj@example.com',
        djName: 'DJ Test',
        selfSignupAt,
        selfSignupDowngradedAt: null,
      },
    ]);

    const rows = await queryPendingSelfSignups();

    expect(rows).toEqual([
      {
        userId: 'u1',
        name: 'Test DJ',
        email: 'testdj@example.com',
        djName: 'DJ Test',
        selfSignupAt,
        selfSignupDowngradedAt: null,
      },
    ]);
  });

  it('tolerates a null djName', async () => {
    const selfSignupAt = new Date('2026-07-01T00:00:00Z');
    mockWhere.mockResolvedValueOnce([
      {
        userId: 'u1',
        name: 'Test DJ',
        email: 'testdj@example.com',
        djName: null,
        selfSignupAt,
        selfSignupDowngradedAt: null,
      },
    ]);

    const rows = await queryPendingSelfSignups();

    expect(rows[0].djName).toBeNull();
  });

  it('defensively drops a row whose selfSignupAt somehow came back null despite the WHERE clause', async () => {
    mockWhere.mockResolvedValueOnce([
      {
        userId: 'u1',
        name: 'Test DJ',
        email: 'testdj@example.com',
        djName: null,
        selfSignupAt: null,
        selfSignupDowngradedAt: null,
      },
    ]);

    const rows = await queryPendingSelfSignups();

    expect(rows).toEqual([]);
  });

  it('returns an empty array when nothing is pending', async () => {
    mockWhere.mockResolvedValueOnce([]);

    const rows = await queryPendingSelfSignups();

    expect(rows).toEqual([]);
  });
});
