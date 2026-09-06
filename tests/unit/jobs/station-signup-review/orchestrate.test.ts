/**
 * Unit tests for orchestrate.run() -- the station-signup-review job's
 * control-flow spine. Every collaborator (query, downgrade, format, email,
 * logger, db) is mocked so these tests pin ONLY the orchestration:
 *
 *   - plan -> notify -> apply ordering, so the digest is never a claim about
 *     a privilege change the operator was not told about first;
 *   - the writes happen REGARDLESS of the send outcome, and the run still
 *     exits non-zero on a send failure;
 *   - the "nothing pending -> nothing sent, nothing planned" short-circuit;
 *   - the recipient-fallback warn + digest-body flag.
 *
 * Mirrors `tests/unit/jobs/metadata-no-match-digest/orchestrate.test.ts`.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockQueryPendingSelfSignups = jest.fn();
jest.mock('../../../../jobs/station-signup-review/query', () => ({
  queryPendingSelfSignups: mockQueryPendingSelfSignups,
}));

const mockPlanDowngrades = jest.fn();
const mockApplyDowngrades = jest.fn();
const mockIsDowngradeEnabled = jest.fn(() => true);
jest.mock('../../../../jobs/station-signup-review/downgrade', () => ({
  planDowngrades: mockPlanDowngrades,
  applyDowngrades: mockApplyDowngrades,
  isDowngradeEnabled: mockIsDowngradeEnabled,
}));

const mockBuildStationSignupDigestEmail = jest.fn();
jest.mock('../../../../jobs/station-signup-review/format', () => ({
  buildStationSignupDigestEmail: mockBuildStationSignupDigestEmail,
}));

const mockSendStationSignupDigestEmail = jest.fn();
const mockResolveStationSignupRecipient = jest.fn(() => ({ address: 'jake@wxyc.org', usedFallback: false }));
jest.mock('../../../../jobs/station-signup-review/email', () => ({
  sendStationSignupDigestEmail: mockSendStationSignupDigestEmail,
  resolveStationSignupRecipient: mockResolveStationSignupRecipient,
}));

const mockLog = jest.fn();
jest.mock('../../../../jobs/station-signup-review/logger', () => ({
  log: mockLog,
  errorMessage: (e: unknown): string => (e instanceof Error ? e.message : JSON.stringify(e)),
}));

const mockDb = { __mock: 'db' };
jest.mock('@wxyc/database', () => ({ db: mockDb }));

import { run } from '../../../../jobs/station-signup-review/orchestrate';

const DIGEST = { subject: 's', html: '<p>h</p>', text: 't' };
const PENDING_ROW = {
  userId: 'u1',
  name: 'Test DJ',
  email: 'testdj@example.com',
  djName: 'DJ Test',
  selfSignupAt: new Date(),
  selfSignupDowngradedAt: null,
};
const PLANNED = { row: PENDING_ROW, status: 'downgraded', downgradedAt: new Date() };
const NOTHING_APPLIED = { downgraded: [], raced: [], failed: [] };

/** Set up the happy path; individual tests override one link. */
const happyPath = (): void => {
  mockQueryPendingSelfSignups.mockResolvedValue([PENDING_ROW] as never);
  mockPlanDowngrades.mockResolvedValue([PLANNED] as never);
  mockBuildStationSignupDigestEmail.mockReturnValue(DIGEST);
  mockSendStationSignupDigestEmail.mockResolvedValue(true as never);
  mockApplyDowngrades.mockResolvedValue({ downgraded: [PENDING_ROW], raced: [], failed: [] } as never);
};

describe('orchestrate.run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveStationSignupRecipient.mockReturnValue({ address: 'jake@wxyc.org', usedFallback: false });
    mockIsDowngradeEnabled.mockReturnValue(true);
  });

  it('queries pending accounts and does nothing else when there are none', async () => {
    mockQueryPendingSelfSignups.mockResolvedValue([] as never);

    await run();

    expect(mockPlanDowngrades).not.toHaveBeenCalled();
    expect(mockApplyDowngrades).not.toHaveBeenCalled();
    expect(mockBuildStationSignupDigestEmail).not.toHaveBeenCalled();
    expect(mockSendStationSignupDigestEmail).not.toHaveBeenCalled();
  });

  it('plans, then sends, then applies -- in that order', async () => {
    happyPath();
    const order: string[] = [];
    mockPlanDowngrades.mockImplementation(() => {
      order.push('plan');
      return Promise.resolve([PLANNED]);
    });
    mockSendStationSignupDigestEmail.mockImplementation(() => {
      order.push('send');
      return Promise.resolve(true);
    });
    mockApplyDowngrades.mockImplementation(() => {
      order.push('apply');
      return Promise.resolve(NOTHING_APPLIED);
    });

    await run();

    expect(order).toEqual(['plan', 'send', 'apply']);
  });

  it('builds the digest from the per-row decisions, not from a filtered downgraded list', async () => {
    happyPath();

    await run();

    expect(mockPlanDowngrades).toHaveBeenCalledWith(mockDb, [PENDING_ROW], expect.any(Date));
    expect(mockBuildStationSignupDigestEmail).toHaveBeenCalledWith(
      [PLANNED],
      expect.objectContaining({ recipientFallbackInUse: false })
    );
  });

  it('sends the digest to the resolved recipient', async () => {
    happyPath();

    await run();

    expect(mockSendStationSignupDigestEmail).toHaveBeenCalledWith('jake@wxyc.org', DIGEST);
  });

  it('warns and flags the digest body when the recipient fell back to the built-in default', async () => {
    happyPath();
    mockResolveStationSignupRecipient.mockReturnValue({ address: 'jake@wxyc.org', usedFallback: true });

    await run();

    expect(mockLog).toHaveBeenCalledWith('warn', 'recipient_fallback', expect.any(String), expect.anything());
    expect(mockBuildStationSignupDigestEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipientFallbackInUse: true })
    );
  });

  it('STILL APPLIES the downgrades when the send throws, and rethrows so the run exits non-zero', async () => {
    // The point of the reordering: the digest is level-triggered, so a failed
    // send costs one day of awareness -- whereas gating the write on SES
    // health would mean an unset SES_FROM_EMAIL silently downgrades nobody,
    // forever.
    happyPath();
    mockSendStationSignupDigestEmail.mockRejectedValue(new Error('SES down') as never);

    await expect(run()).rejects.toThrow('SES down');
    expect(mockApplyDowngrades).toHaveBeenCalledWith(mockDb, [PLANNED], expect.any(Date));
  });

  it('applies the downgrades on a disabled (EMAIL_ENABLED=false) run and completes cleanly', async () => {
    happyPath();
    mockSendStationSignupDigestEmail.mockResolvedValue(false as never);

    await expect(run()).resolves.toBeUndefined();
    expect(mockApplyDowngrades).toHaveBeenCalled();
  });

  it('rethrows a per-account write failure so the run exits non-zero', async () => {
    happyPath();
    mockApplyDowngrades.mockResolvedValue({
      downgraded: [],
      raced: [],
      failed: [{ row: PENDING_ROW, error: new Error('deadlock detected') }],
    } as never);

    await expect(run()).rejects.toThrow('deadlock detected');
  });

  it('prefers the send error over the write error when both fail -- the send failure means a human was not told', async () => {
    happyPath();
    mockSendStationSignupDigestEmail.mockRejectedValue(new Error('SES down') as never);
    mockApplyDowngrades.mockRejectedValue(new Error('deadlock detected') as never);

    await expect(run()).rejects.toThrow('SES down');
    // Both are still logged.
    expect(mockLog).toHaveBeenCalledWith('error', 'send_failed', expect.any(String), expect.anything());
    expect(mockLog).toHaveBeenCalledWith('error', 'downgrade_failed', expect.any(String), expect.anything());
  });

  it('logs a raced account (state changed between plan and write) as a warning, not a failure', async () => {
    happyPath();
    mockApplyDowngrades.mockResolvedValue({ downgraded: [], raced: [PENDING_ROW], failed: [] } as never);

    await expect(run()).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith('warn', 'downgrade_raced', expect.any(String), expect.anything());
  });
});
