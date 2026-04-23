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
  },
  password: {
    hash: mockPasswordHash,
  },
};

jest.mock('@wxyc/authentication', () => ({
  auth: {
    $context: Promise.resolve(mockAuthContext),
  },
  WXYCRoles: {
    member: {},
    dj: {},
    musicDirector: {},
    stationManager: {},
  },
}));

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
  mockAdapterFindOne.mockResolvedValue(fakeOrg);
  mockCreateUser.mockResolvedValue(fakeUser);
  mockPasswordHash.mockResolvedValue('hashed-password');
  mockLinkAccount.mockResolvedValue(undefined);
  mockAdapterCreate.mockResolvedValue(fakeMember);
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
