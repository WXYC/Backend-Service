/**
 * Account-setup invite revocation: issuing a new invite (or finishing
 * onboarding) must leave at most ONE live `reset-password:` row for the user.
 *
 * Why this exists: better-auth's `POST /reset-password` consumes only the token
 * it is handed (`consumeVerificationValue`) and never sweeps the user's other
 * outstanding rows, so every roster "Send Invite" resend used to add another
 * concurrently-valid account-takeover credential with a full TTL of life left.
 *
 * These are behavioral tests against a recording fake `db`. The WHERE predicate
 * itself (right user, right identifier prefix, right exclusion) is pinned
 * end-to-end against real PostgreSQL in
 * `tests/integration/complete-onboarding-token.spec.js` — a mocked drizzle
 * chain can't prove a predicate, only that one was passed.
 */

import { jest } from '@jest/globals';

// --- Mocks ---

const mockReturning = jest.fn().mockResolvedValue([{ id: 'v1' }, { id: 'v2' }] as never);
const mockWhere = jest.fn(() => ({ returning: mockReturning }));
const mockDelete = jest.fn(() => ({ where: mockWhere }));

jest.mock('@wxyc/database', () => ({
  db: { delete: (...args: unknown[]) => mockDelete(...args) },
  verification: {
    id: { name: 'id' },
    identifier: { name: 'identifier' },
    value: { name: 'value' },
    createdAt: { name: 'createdAt' },
  },
}));

// drizzle's operators are pure SQL builders; stub them so the fake columns
// above don't have to satisfy the real Column interface. The assertions below
// check which operator was applied, not the SQL it renders.
jest.mock('drizzle-orm', () => ({
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  like: (col: unknown, val: unknown) => ({ op: 'like', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
}));

const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

import {
  revokeOutstandingAccountSetupTokens,
  ACCOUNT_SETUP_TOKEN_PREFIX,
} from '../../../shared/authentication/src/revoke-account-setup-tokens';

/** Flatten the nested and()/eq()/like()/ne() tree into a comparable list. */
type Clause = { op: string; parts?: Clause[]; col?: { name?: string }; val?: unknown };
function flatten(clause: Clause): Clause[] {
  if (clause.op === 'and') return (clause.parts ?? []).flatMap(flatten);
  return [clause];
}

describe('revokeOutstandingAccountSetupTokens()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }] as never);
  });

  it('deletes the user’s outstanding reset-password rows and returns the count', async () => {
    const revoked = await revokeOutstandingAccountSetupTokens('user-id-001');

    expect(revoked).toBe(2);
    expect(mockDelete).toHaveBeenCalledTimes(1);

    const clauses = flatten(mockWhere.mock.calls[0][0]);
    // scoped to this user
    expect(clauses).toContainEqual(expect.objectContaining({ op: 'eq', col: { name: 'value' }, val: 'user-id-001' }));
    // and only to account-setup / reset-password rows
    expect(clauses).toContainEqual(
      expect.objectContaining({ op: 'like', col: { name: 'identifier' }, val: `${ACCOUNT_SETUP_TOKEN_PREFIX}%` })
    );
  });

  it('spares the just-minted token when exceptIdentifier is given', async () => {
    await revokeOutstandingAccountSetupTokens('user-id-001', {
      exceptIdentifier: 'reset-password:keep-me',
    });

    const clauses = flatten(mockWhere.mock.calls[0][0]);
    expect(clauses).toContainEqual(
      expect.objectContaining({ op: 'ne', col: { name: 'identifier' }, val: 'reset-password:keep-me' })
    );
  });

  // Two admins clicking "Send Invite" at the same moment must not revoke each
  // other's brand-new token and leave the DJ with two dead links. Bounding the
  // delete to rows OLDER than the caller's own mint makes the newest invite win
  // under either interleaving.
  it('deletes only rows older than the caller’s own mint when createdBefore is given', async () => {
    const mintedAt = new Date('2026-08-28T12:00:00.000Z');

    await revokeOutstandingAccountSetupTokens('user-id-001', {
      exceptIdentifier: 'reset-password:keep-me',
      createdBefore: mintedAt,
    });

    const clauses = flatten(mockWhere.mock.calls[0][0]);
    expect(clauses).toContainEqual(expect.objectContaining({ op: 'lt', col: { name: 'createdAt' }, val: mintedAt }));
  });

  it('applies no exclusion when exceptIdentifier is omitted', async () => {
    await revokeOutstandingAccountSetupTokens('user-id-001');

    const clauses = flatten(mockWhere.mock.calls[0][0]);
    expect(clauses.some((c) => c.op === 'ne')).toBe(false);
    // and no age bound either: onboarding is done, nothing should survive
    expect(clauses.some((c) => c.op === 'lt')).toBe(false);
  });

  it('swallows a DB failure, captures it, and reports zero revoked', async () => {
    mockReturning.mockRejectedValue(new Error('connection terminated') as never);

    // Never throws: revocation is a hardening step on paths (invite send,
    // onboarding completion) that must still succeed for the DJ.
    await expect(revokeOutstandingAccountSetupTokens('user-id-001')).resolves.toBe(0);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { subsystem: 'account-setup-invite', step: 'revoke-outstanding-tokens' },
        extra: { userId: 'user-id-001' },
      })
    );
  });
});
