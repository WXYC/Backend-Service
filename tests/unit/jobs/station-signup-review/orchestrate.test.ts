/**
 * Unit tests for orchestrate.run() -- the station-signup-review job's
 * control-flow spine. Every collaborator (query, downgrade, format, email,
 * logger, db) is mocked so these tests pin ONLY the orchestration: the
 * downgrade-before-digest ordering, the "nothing pending -> nothing sent"
 * short-circuit, and send-failure/disabled handling. Mirrors
 * `tests/unit/jobs/metadata-no-match-digest/orchestrate.test.ts`.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockQueryPendingSelfSignups = jest.fn();
jest.mock('../../../../jobs/station-signup-review/query', () => ({
  queryPendingSelfSignups: mockQueryPendingSelfSignups,
}));

const mockDowngradeOverdueAccounts = jest.fn();
jest.mock('../../../../jobs/station-signup-review/downgrade', () => ({
  downgradeOverdueAccounts: mockDowngradeOverdueAccounts,
}));

const mockBuildStationSignupDigestEmail = jest.fn();
jest.mock('../../../../jobs/station-signup-review/format', () => ({
  buildStationSignupDigestEmail: mockBuildStationSignupDigestEmail,
}));

const mockSendStationSignupDigestEmail = jest.fn();
const mockResolveStationSignupRecipient = jest.fn(() => 'jake@wxyc.org');
jest.mock('../../../../jobs/station-signup-review/email', () => ({
  sendStationSignupDigestEmail: mockSendStationSignupDigestEmail,
  resolveStationSignupRecipient: mockResolveStationSignupRecipient,
}));

jest.mock('../../../../jobs/station-signup-review/logger', () => ({
  log: jest.fn(),
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
};

describe('orchestrate.run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveStationSignupRecipient.mockReturnValue('jake@wxyc.org');
  });

  it('queries pending accounts and sends nothing when there are none -- downgrade and format are never called', async () => {
    mockQueryPendingSelfSignups.mockResolvedValue([] as never);

    await run();

    expect(mockDowngradeOverdueAccounts).not.toHaveBeenCalled();
    expect(mockBuildStationSignupDigestEmail).not.toHaveBeenCalled();
    expect(mockSendStationSignupDigestEmail).not.toHaveBeenCalled();
  });

  it('runs the downgrade pass BEFORE building the digest, and passes the downgraded rows into it', async () => {
    mockQueryPendingSelfSignups.mockResolvedValue([PENDING_ROW] as never);
    mockDowngradeOverdueAccounts.mockResolvedValue([PENDING_ROW] as never);
    mockBuildStationSignupDigestEmail.mockReturnValue(DIGEST);
    mockSendStationSignupDigestEmail.mockResolvedValue(true as never);

    await run();

    expect(mockDowngradeOverdueAccounts).toHaveBeenCalledWith(mockDb, [PENDING_ROW], expect.any(Date));
    expect(mockBuildStationSignupDigestEmail).toHaveBeenCalledWith(
      [PENDING_ROW],
      expect.objectContaining({ downgraded: [PENDING_ROW] })
    );
  });

  it('sends the digest to the resolved recipient when accounts are pending', async () => {
    mockQueryPendingSelfSignups.mockResolvedValue([PENDING_ROW] as never);
    mockDowngradeOverdueAccounts.mockResolvedValue([] as never);
    mockBuildStationSignupDigestEmail.mockReturnValue(DIGEST);
    mockSendStationSignupDigestEmail.mockResolvedValue(true as never);

    await run();

    expect(mockSendStationSignupDigestEmail).toHaveBeenCalledWith('jake@wxyc.org', DIGEST);
  });

  it('rethrows and never swallows a send failure', async () => {
    mockQueryPendingSelfSignups.mockResolvedValue([PENDING_ROW] as never);
    mockDowngradeOverdueAccounts.mockResolvedValue([] as never);
    mockBuildStationSignupDigestEmail.mockReturnValue(DIGEST);
    mockSendStationSignupDigestEmail.mockRejectedValue(new Error('SES down') as never);

    await expect(run()).rejects.toThrow('SES down');
  });

  it('completes without throwing on a disabled (EMAIL_ENABLED=false) observe-only run', async () => {
    mockQueryPendingSelfSignups.mockResolvedValue([PENDING_ROW] as never);
    mockDowngradeOverdueAccounts.mockResolvedValue([] as never);
    mockBuildStationSignupDigestEmail.mockReturnValue(DIGEST);
    mockSendStationSignupDigestEmail.mockResolvedValue(false as never);

    await expect(run()).resolves.toBeUndefined();
  });
});
