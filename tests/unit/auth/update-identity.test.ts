import { jest } from '@jest/globals';

const mockUpdateUser = jest.fn();
const mockGetSession = jest.fn();
const mockRecordAccountAuditEvent = jest.fn();

const mockAuthContext = {
  internalAdapter: {
    updateUser: mockUpdateUser,
  },
};

jest.mock('@wxyc/authentication', () => ({
  auth: {
    $context: Promise.resolve(mockAuthContext),
    api: { getSession: mockGetSession },
  },
  // Real implementation, not a stub: it is pure (no DB import), matching the
  // BS#1107 convention tests/mocks/authentication.mock.ts already applies.
  deriveStationSignupIpHash: jest.requireActual<typeof import('../../../shared/authentication/src/signup-ip-hash')>(
    '../../../shared/authentication/src/signup-ip-hash'
  ).deriveStationSignupIpHash,
}));
jest.mock('@wxyc/database', () => ({
  recordAccountAuditEvent: (...args: unknown[]) => mockRecordAccountAuditEvent(...args),
}));

import { UpdateIdentityError, updateIdentityFromRequest } from '../../../apps/auth/update-identity';

const emptyHeaders = new Headers();

const signedInAs = (user: Record<string, unknown>): void => {
  mockGetSession.mockResolvedValue({ user: { id: 'user-id-001', ...user } } as never);
};

beforeEach(() => {
  jest.clearAllMocks();
  signedInAs({});
  mockUpdateUser.mockResolvedValue(undefined as never);
  mockRecordAccountAuditEvent.mockResolvedValue(undefined as never);
});

// The regression this endpoint exists for: BS#2297 locked realName/djName to
// `input: false`, which closed better-auth's public POST /update-user to the
// two fields AND to the settings form that is the DJ's only way to edit them.
// dj-site's "Your Information" modal has returned
// `djName is not allowed to be set` since 2026-08-28.
describe('updateIdentityFromRequest', () => {
  describe('authentication', () => {
    it('rejects an unauthenticated request with 401', async () => {
      mockGetSession.mockResolvedValue(null as never);

      await expect(updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('rejects an anonymous session with 403', async () => {
      signedInAs({ isAnonymous: true });

      await expect(updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  describe('writes', () => {
    it('updates djName on the session user', async () => {
      const result = await updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders);

      expect(mockUpdateUser).toHaveBeenCalledWith('user-id-001', { djName: 'DJ spacetime' });
      expect(result).toMatchObject({ status: true, userId: 'user-id-001', djName: 'DJ spacetime' });
    });

    it('updates realName on the session user', async () => {
      await updateIdentityFromRequest({ realName: 'Kate Bailey' }, emptyHeaders);

      expect(mockUpdateUser).toHaveBeenCalledWith('user-id-001', { realName: 'Kate Bailey' });
    });

    it('updates both fields in a single write', async () => {
      await updateIdentityFromRequest({ realName: 'Kate Bailey', djName: 'DJ spacetime' }, emptyHeaders);

      expect(mockUpdateUser).toHaveBeenCalledWith('user-id-001', {
        realName: 'Kate Bailey',
        djName: 'DJ spacetime',
      });
    });

    it('trims surrounding whitespace before writing', async () => {
      await updateIdentityFromRequest({ djName: '  DJ spacetime  ' }, emptyHeaders);

      expect(mockUpdateUser).toHaveBeenCalledWith('user-id-001', { djName: 'DJ spacetime' });
    });

    // The session is the ONLY source of the subject id. A body-supplied userId
    // would turn a self-service endpoint into an admin one.
    it('ignores a body-supplied userId and writes to the session user', async () => {
      await updateIdentityFromRequest({ djName: 'DJ spacetime', userId: 'someone-else' }, emptyHeaders);

      expect(mockUpdateUser).toHaveBeenCalledWith('user-id-001', { djName: 'DJ spacetime' });
    });
  });

  // The endpoint forwards an allowlist, never the body. Spreading the body
  // here would reopen every hole BS#2297's input:false lock closed — this time
  // on a route that bypasses better-auth's parseUserInput entirely.
  describe('field allowlist', () => {
    it.each([
      ['name', { name: 'Kate Bailey' }],
      ['capabilities', { capabilities: ['admin'] }],
      ['role', { role: 'admin' }],
      ['hasCompletedOnboarding', { hasCompletedOnboarding: true }],
      ['emailVerified', { emailVerified: true }],
      ['selfSignupReviewedAt', { selfSignupReviewedAt: new Date().toISOString() }],
    ])('drops %s from the payload', async (_label, extra) => {
      await updateIdentityFromRequest({ djName: 'DJ spacetime', ...extra }, emptyHeaders);

      expect(mockUpdateUser).toHaveBeenCalledWith('user-id-001', { djName: 'DJ spacetime' });
    });
  });

  describe('validation', () => {
    it('rejects a request carrying neither field', async () => {
      await expect(updateIdentityFromRequest({}, emptyHeaders)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it.each([
      ['realName', ''],
      ['realName', '   '],
      ['djName', ''],
      ['djName', '   '],
    ])('rejects a blank %s rather than clearing it', async (field, value) => {
      await expect(updateIdentityFromRequest({ [field]: value }, emptyHeaders)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it.each([['realName'], ['djName']])('rejects a %s longer than 255 characters', async (field) => {
      await expect(updateIdentityFromRequest({ [field]: 'x'.repeat(256) }, emptyHeaders)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it.each([['realName'], ['djName']])('rejects a non-string %s', async (field) => {
      await expect(updateIdentityFromRequest({ [field]: 42 }, emptyHeaders)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    // resolveDjDisplayName treats "Anonymous" as unusable, so the
    // databaseHooks.user.update.before hook would leave auth_user.name at its
    // prior value while dj_name became "Anonymous" — the split state behind
    // the 2026-06-02 on-air incident (BS#1286). Refuse it at the door.
    it.each([['Anonymous'], ['anonymous'], ['  ANONYMOUS  ']])('rejects the reserved handle %s', async (djName) => {
      await expect(updateIdentityFromRequest({ djName }, emptyHeaders)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_DJ_NAME',
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  describe('audit', () => {
    it('records a success against the session user as both actor and subject', async () => {
      await updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders);

      expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'wxyc.update-identity',
          actorUserId: 'user-id-001',
          subjectUserId: 'user-id-001',
          outcome: 200,
          source: 'http',
        }),
        expect.anything()
      );
    });

    it('records the status code and code of a rejection', async () => {
      await expect(updateIdentityFromRequest({}, emptyHeaders)).rejects.toBeInstanceOf(UpdateIdentityError);

      expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'wxyc.update-identity', outcome: 400, errorCode: 'INVALID_REQUEST' }),
        expect.anything()
      );
    });

    // The audit row must never carry the new or old name — this is the PII
    // column pair, and account_audit_event has no field for a value anyway.
    it('records no field values', async () => {
      await updateIdentityFromRequest({ realName: 'Kate Bailey', djName: 'DJ spacetime' }, emptyHeaders);

      const [event] = mockRecordAccountAuditEvent.mock.calls[0] as [Record<string, unknown>];
      expect(JSON.stringify(event)).not.toContain('Kate Bailey');
      expect(JSON.stringify(event)).not.toContain('DJ spacetime');
    });
  });

  it('surfaces an adapter failure as a 500-class error, not a silent success', async () => {
    mockUpdateUser.mockRejectedValue(new Error('connection terminated') as never);

    await expect(updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders)).rejects.toThrow(
      'connection terminated'
    );
  });
});
