import { jest } from '@jest/globals';

// --- Mocks ---

// Mock better-auth modules (ESM-only)
jest.mock('better-auth/plugins/access', () => ({
  createAccessControl: () => ({
    newRole: (statements: any) => ({
      authorize: () => ({ success: true }),
      statements,
    }),
  }),
}));

jest.mock('better-auth/plugins/organization/access', () => ({
  adminAc: { statements: {} },
  defaultStatements: {},
}));

// Mock Sentry so the new captureException calls don't blow up in tests
const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

// Mock @wxyc/database for admin role sync
const mockDbUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue(undefined as never),
  }),
});

jest.mock('@wxyc/database', () => ({
  db: { update: (...args: unknown[]) => mockDbUpdate(...args) },
  user: { id: 'id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
}));

// Mock auth context used by provisionUser()
const mockFindUserByEmail = jest.fn();
const mockCreateUser = jest.fn();
const mockLinkAccount = jest.fn();
const mockDeleteUser = jest.fn();
const mockAdapterFindOne = jest.fn();
const mockAdapterCreate = jest.fn();
const mockAdapterUpdate = jest.fn();
const mockPasswordHash = jest.fn();

const mockAuthContext = {
  internalAdapter: {
    findUserByEmail: mockFindUserByEmail,
    createUser: mockCreateUser,
    linkAccount: mockLinkAccount,
    deleteUser: mockDeleteUser,
  },
  adapter: {
    findOne: mockAdapterFindOne,
    create: mockAdapterCreate,
    update: mockAdapterUpdate,
  },
  password: {
    hash: mockPasswordHash,
  },
};

const mockRequestPasswordReset = jest.fn().mockResolvedValue({ status: true } as never);

jest.mock('@wxyc/authentication', () => {
  // Use the real validator so the tests exercise the production regex.
  const actual = jest.requireActual('../../../shared/authentication/src/auth.username');
  return {
    ...actual,
    auth: {
      $context: Promise.resolve(mockAuthContext),
      api: {
        requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
      },
    },
    WXYCRoles: {
      member: {},
      dj: {},
      musicDirector: {},
      stationManager: {},
    },
  };
});

// --- Import after mocks ---
import { provisionUser, ProvisionError } from '../../../apps/auth/provision-user';

// --- Helpers ---
const validInput = {
  email: 'newdj@test.wxyc.org',
  username: 'new_dj',
  password: 'temppass123',
  name: 'New DJ',
  organizationSlug: 'test-org',
  role: 'dj',
  realName: 'Jane Doe',
  djName: 'DJ Jazzy Jane',
};

const fakeUser = {
  id: 'user-id-001',
  email: validInput.email,
  username: validInput.username,
  name: validInput.name,
};

const fakeOrg = {
  id: 'test-org-id-0000000000000000001',
  name: 'Test Organization',
  slug: 'test-org',
};

const fakeMember = {
  id: 'member-id-001',
  userId: fakeUser.id,
  organizationId: fakeOrg.id,
  role: 'dj',
};

function setUpHappyPath() {
  mockFindUserByEmail.mockResolvedValue(null);
  // adapter.findOne is called for both the org lookup and the upsert member
  // lookup. Default: return the org for {model: 'organization'} and null for
  // {model: 'member'} (i.e. no existing member row — fall into the insert
  // branch). Individual tests can override to simulate an existing row from
  // the databaseHooks.user.create.after auto-membership hook.
  mockAdapterFindOne.mockImplementation((query: { model: string }) => {
    if (query?.model === 'organization') return Promise.resolve(fakeOrg);
    if (query?.model === 'member') return Promise.resolve(null);
    return Promise.resolve(null);
  });
  mockCreateUser.mockResolvedValue(fakeUser);
  mockPasswordHash.mockResolvedValue('hashed-password');
  mockLinkAccount.mockResolvedValue(undefined);
  mockAdapterCreate.mockResolvedValue(fakeMember);
  mockAdapterUpdate.mockResolvedValue(undefined);
  mockDeleteUser.mockResolvedValue(undefined);
}

// --- Tests ---

describe('provisionUser()', () => {
  beforeEach(() => {
    setUpHappyPath();
    mockDbUpdate.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined as never),
      }),
    });
  });

  describe('happy path', () => {
    it('should create a user and add them to the organization', async () => {
      const result = await provisionUser(validInput);

      expect(result.user).toEqual(fakeUser);
      expect(result.member).toEqual(fakeMember);
    });

    it('should create the user with emailVerified and hasCompletedOnboarding', async () => {
      await provisionUser(validInput);

      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: validInput.email,
          emailVerified: true,
          hasCompletedOnboarding: false,
          appSkin: 'modern-light',
          username: validInput.username,
          name: validInput.name,
        })
      );
    });

    it('should hash the password and link a credential account', async () => {
      await provisionUser(validInput);

      expect(mockPasswordHash).toHaveBeenCalledWith(validInput.password);
      expect(mockLinkAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: fakeUser.id,
          providerId: 'credential',
          password: 'hashed-password',
          userId: fakeUser.id,
        })
      );
    });

    it('should look up the organization by slug', async () => {
      await provisionUser(validInput);

      expect(mockAdapterFindOne).toHaveBeenCalledWith({
        model: 'organization',
        where: [{ field: 'slug', value: 'test-org' }],
      });
    });

    it('should create the member with the correct organization ID and role', async () => {
      await provisionUser(validInput);

      expect(mockAdapterCreate).toHaveBeenCalledWith({
        model: 'member',
        data: expect.objectContaining({
          userId: fakeUser.id,
          organizationId: fakeOrg.id,
          role: 'dj',
        }),
      });
    });
  });

  describe('upsert against auto-created member row', () => {
    // The databaseHooks.user.create.after hook in auth.definition.ts
    // auto-creates a member row with role='member' for every non-anonymous
    // user. provisionUser must detect this and update the role instead of
    // attempting a second insert (which would fail on the unique
    // (organization_id, user_id) constraint).
    const autoCreatedMember = {
      id: 'auto-member-id-001',
      userId: fakeUser.id,
      organizationId: fakeOrg.id,
      role: 'member',
    };

    it('should update the existing member row to the requested role', async () => {
      mockAdapterFindOne.mockImplementation((query: { model: string }) => {
        if (query?.model === 'organization') return Promise.resolve(fakeOrg);
        if (query?.model === 'member') return Promise.resolve(autoCreatedMember);
        return Promise.resolve(null);
      });

      const result = await provisionUser({ ...validInput, role: 'musicDirector' });

      expect(mockAdapterUpdate).toHaveBeenCalledWith({
        model: 'member',
        where: [{ field: 'id', value: autoCreatedMember.id }],
        update: { role: 'musicDirector' },
      });
      expect(mockAdapterCreate).not.toHaveBeenCalledWith(expect.objectContaining({ model: 'member' }));
      expect(result.member.role).toBe('musicDirector');
    });

    it('should skip the update when the auto-created role already matches', async () => {
      mockAdapterFindOne.mockImplementation((query: { model: string }) => {
        if (query?.model === 'organization') return Promise.resolve(fakeOrg);
        if (query?.model === 'member') return Promise.resolve(autoCreatedMember);
        return Promise.resolve(null);
      });

      const result = await provisionUser({ ...validInput, role: 'member' });

      expect(mockAdapterUpdate).not.toHaveBeenCalled();
      expect(mockAdapterCreate).not.toHaveBeenCalledWith(expect.objectContaining({ model: 'member' }));
      expect(result.member.role).toBe('member');
    });

    it('should still sync user.role to admin when upserting to stationManager', async () => {
      mockAdapterFindOne.mockImplementation((query: { model: string }) => {
        if (query?.model === 'organization') return Promise.resolve(fakeOrg);
        if (query?.model === 'member') return Promise.resolve(autoCreatedMember);
        return Promise.resolve(null);
      });

      await provisionUser({ ...validInput, role: 'stationManager' });

      expect(mockAdapterUpdate).toHaveBeenCalled();
      expect(mockDbUpdate).toHaveBeenCalled();
    });
  });

  describe('username validation', () => {
    it.each([['billb'], ['bill_b'], ['bill.b'], ['BillB'], ['dj42'], ['abc'], ['a'.repeat(30)]])(
      'should accept valid username: "%s"',
      async (username) => {
        await expect(provisionUser({ ...validInput, username })).resolves.toBeDefined();
      }
    );

    it.each([
      ['contains a space', 'bill b'],
      ['contains a dash', 'bill-b'],
      ['contains an @', 'bill@b'],
      ['contains punctuation', "bill's"],
      ['contains unicode', 'billé'],
      ['leading space', ' billb'],
      ['trailing space', 'billb '],
      ['too short (1 char)', 'a'],
      ['too short (2 chars)', 'ab'],
      ['too long (31 chars)', 'a'.repeat(31)],
      ['empty string', ''],
    ])('should reject invalid username (%s)', async (_label, username) => {
      await expect(provisionUser({ ...validInput, username })).rejects.toThrow(ProvisionError);
      await expect(provisionUser({ ...validInput, username })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('should not call createUser when username is invalid', async () => {
      await provisionUser({ ...validInput, username: 'bill b' }).catch(() => {});
      expect(mockCreateUser).not.toHaveBeenCalled();
    });
  });

  describe('role validation', () => {
    it.each(['member', 'dj', 'musicDirector', 'stationManager'])('should accept valid role: %s', async (role) => {
      await expect(provisionUser({ ...validInput, role })).resolves.toBeDefined();
    });

    it.each(['admin', 'owner', 'superuser', ''])('should reject invalid role: "%s"', async (role) => {
      await expect(provisionUser({ ...validInput, role })).rejects.toThrow(ProvisionError);
      await expect(provisionUser({ ...validInput, role })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('duplicate email', () => {
    it('should throw 409 when user with email already exists', async () => {
      mockFindUserByEmail.mockResolvedValue({ id: 'existing-user', email: validInput.email });

      await expect(provisionUser(validInput)).rejects.toThrow(ProvisionError);
      await expect(provisionUser(validInput)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should not create any user when email already exists', async () => {
      mockFindUserByEmail.mockResolvedValue({ id: 'existing-user', email: validInput.email });

      await provisionUser(validInput).catch(() => {});
      expect(mockCreateUser).not.toHaveBeenCalled();
    });
  });

  describe('duplicate username', () => {
    it('should throw 409 when username unique constraint is violated', async () => {
      mockCreateUser.mockRejectedValue(new Error('unique constraint violated'));

      await expect(provisionUser(validInput)).rejects.toThrow(ProvisionError);
      await expect(provisionUser(validInput)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should rethrow non-uniqueness errors from createUser', async () => {
      mockCreateUser.mockRejectedValue(new Error('connection timeout'));

      await expect(provisionUser(validInput)).rejects.toThrow('connection timeout');
    });
  });

  describe('organization not found', () => {
    it('should throw 404 when organization slug does not exist', async () => {
      mockAdapterFindOne.mockResolvedValue(null);

      await expect(provisionUser(validInput)).rejects.toThrow(ProvisionError);
      await expect(provisionUser(validInput)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('should not create any user when org is not found', async () => {
      mockAdapterFindOne.mockResolvedValue(null);

      await provisionUser(validInput).catch(() => {});
      expect(mockCreateUser).not.toHaveBeenCalled();
    });
  });

  describe('admin role sync', () => {
    it('should set user.role to admin for stationManager', async () => {
      await provisionUser({ ...validInput, role: 'stationManager' });

      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it('should NOT set user.role for dj', async () => {
      await provisionUser({ ...validInput, role: 'dj' });

      expect(mockDbUpdate).not.toHaveBeenCalled();
    });

    it('should NOT set user.role for member', async () => {
      await provisionUser({ ...validInput, role: 'member' });

      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  describe('welcome email', () => {
    it('should trigger password reset flow after successful provisioning', async () => {
      await provisionUser(validInput);

      expect(mockRequestPasswordReset).toHaveBeenCalledWith({
        body: { email: validInput.email, redirectTo: expect.stringContaining('/login') },
        headers: expect.any(Headers),
      });
    });

    it('should not trigger password reset if user creation fails', async () => {
      mockCreateUser.mockRejectedValue(new Error('unique constraint violated'));

      await provisionUser(validInput).catch(() => {});

      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });

    it('should not trigger password reset if member creation fails', async () => {
      mockAdapterCreate.mockRejectedValue(new Error('DB constraint violation'));

      await provisionUser(validInput).catch(() => {});

      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });

    it('should not block provisioning if password reset trigger fails', async () => {
      mockRequestPasswordReset.mockRejectedValue(new Error('SES error'));

      const result = await provisionUser(validInput);

      expect(result.user).toEqual(fakeUser);
    });

    it('should report emailSent=true on success', async () => {
      mockRequestPasswordReset.mockResolvedValue({ status: true } as never);

      const result = await provisionUser(validInput);

      expect(result.emailSent).toBe(true);
      expect(result.emailError).toBeUndefined();
    });

    it('should report emailSent=false with emailError on failure', async () => {
      mockSentryCaptureException.mockClear();
      mockRequestPasswordReset.mockRejectedValue(new Error('SES throttled'));

      const result = await provisionUser(validInput);

      expect(result.emailSent).toBe(false);
      expect(result.emailError).toBe('SES throttled');
      // user still created — provisioning is not aborted
      expect(result.user).toEqual(fakeUser);
      expect(result.member).toBeDefined();
      // observability: regression-guard so dropping the Sentry capture would
      // fail loudly instead of silently degrading monitoring
      expect(mockSentryCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { subsystem: 'provision-user', step: 'request-password-reset' },
          extra: expect.objectContaining({ email: validInput.email, userId: fakeUser.id }),
        })
      );
    });

    it('should await the password reset call (not fire-and-forget)', async () => {
      let resolved = false;
      mockRequestPasswordReset.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              resolved = true;
              resolve();
            }, 10);
          })
      );

      await provisionUser(validInput);

      // If the call were fire-and-forget, provisionUser would return before
      // the promise settled and `resolved` would still be false here.
      expect(resolved).toBe(true);
    });
  });

  describe('cleanup on failure', () => {
    it('should delete the created user if member creation fails', async () => {
      mockAdapterCreate.mockRejectedValue(new Error('DB constraint violation'));

      await expect(provisionUser(validInput)).rejects.toThrow('DB constraint violation');
      expect(mockDeleteUser).toHaveBeenCalledWith(fakeUser.id);
    });

    it('should delete the created user if linkAccount fails', async () => {
      mockLinkAccount.mockRejectedValue(new Error('Link failed'));

      await expect(provisionUser(validInput)).rejects.toThrow('Link failed');
      expect(mockDeleteUser).toHaveBeenCalledWith(fakeUser.id);
    });
  });
});
