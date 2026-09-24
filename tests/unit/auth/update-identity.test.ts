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
  // Real implementation, same reason as deriveStationSignupIpHash above: it is
  // pure (dj-name.ts imports nothing) and it is the canonical rule the route
  // delegates its handle check to. Stubbing it would let the route's guard
  // pass a test while disagreeing with the predicate production uses.
  resolveDjDisplayName: jest.requireActual<typeof import('../../../shared/database/src/dj-name')>(
    '../../../shared/database/src/dj-name'
  ).resolveDjDisplayName,
}));

import { EDITABLE_FIELDS, UpdateIdentityError, updateIdentityFromRequest } from '../../../apps/auth/update-identity';

const emptyHeaders = new Headers();

const signedInAs = (user: Record<string, unknown>): void => {
  mockGetSession.mockResolvedValue({ user: { id: 'user-id-001', ...user } } as never);
};

beforeEach(() => {
  jest.clearAllMocks();
  signedInAs({});
  // Truthy: the route now treats a null/undefined return as a write that
  // did not land. The real adapter returns the updated row.
  mockUpdateUser.mockResolvedValue({ id: 'user-id-001' } as never);
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

    // The table above is a hand-written list of field names, which is exactly
    // the shape BS#2358 inverted `pii-additional-fields-input.test.ts` away
    // from: such a list "structurally could not catch the failure it exists to
    // prevent -- a field nobody remembers to add to the list", and
    // `capabilities` and `hasCompletedOnboarding` are the two it named as
    // having slipped through one. So pin the allowlist ITSELF by value.
    // Widening it then has to be a deliberate, reviewable edit here, on the
    // one route that by its own docblock has no `parseUserInput` behind it.
    it('admits exactly two fields, so a third cannot be added silently', () => {
      expect([...EDITABLE_FIELDS]).toEqual(['realName', 'djName']);
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

    // Only an ABSENT key means "leave unchanged". Paired with a valid field so
    // the emptiness check can't be what rejects it -- that is the shape where
    // treating null as absent would return 200 having written only half of
    // what was sent.
    it.each([['realName'], ['djName']])('rejects an explicit null %s rather than ignoring it', async (field) => {
      const other = field === 'realName' ? 'djName' : 'realName';
      await expect(
        updateIdentityFromRequest({ [other]: 'Juana Molina', [field]: null }, emptyHeaders)
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
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

    // Every outcome but the 401 has a resolved session. An unattributable row
    // is the failure mode here: a DJ retrying a rejected handle would fill the
    // table with NULL-actor rows nobody can trace.
    it.each([
      ['a validation rejection', { djName: 'x'.repeat(256) }],
      ['a reserved-handle rejection', { djName: 'Anonymous' }],
    ])('names the actor on %s, not just on success', async (_label, body) => {
      await expect(updateIdentityFromRequest(body, emptyHeaders)).rejects.toBeInstanceOf(UpdateIdentityError);

      expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'user-id-001', subjectUserId: 'user-id-001' }),
        expect.anything()
      );
    });

    it('leaves the actor unset when there is no session to attribute to', async () => {
      mockGetSession.mockResolvedValue(null as never);

      await expect(updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders)).rejects.toBeInstanceOf(
        UpdateIdentityError
      );

      const [event] = mockRecordAccountAuditEvent.mock.calls[0] as [Record<string, unknown>];
      expect(event.actorUserId).toBeUndefined();
      expect(event.outcome).toBe(401);
    });

    // Without this the row names the impersonated DJ as sole actor, so a
    // manager renaming someone while impersonating them is indistinguishable
    // from the DJ doing it themselves.
    it('records the impersonator when the session is an impersonation', async () => {
      mockGetSession.mockResolvedValue({
        user: { id: 'user-id-001' },
        session: { impersonatedBy: 'manager-id-009' },
      } as never);

      await updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders);

      expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-id-001',
          subjectUserId: 'user-id-001',
          impersonatorUserId: 'manager-id-009',
        }),
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

  // `updateWithHooks` answers null on a vetoed write, and the drizzle adapter
  // answers null when the WHERE matched no row -- an account deleted between
  // the session check and the write. Discarding that return is the only way
  // this route could report a write that never landed.
  it('does not report success when the adapter reports no row updated', async () => {
    mockUpdateUser.mockResolvedValue(null as never);

    await expect(updateIdentityFromRequest({ djName: 'DJ spacetime' }, emptyHeaders)).rejects.toMatchObject({
      statusCode: 500,
      code: 'UPDATE_FAILED',
    });

    expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 500, errorCode: 'UPDATE_FAILED' }),
      expect.anything()
    );
  });
});
