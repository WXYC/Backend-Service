import { jest } from '@jest/globals';

// --- Mocks ---

const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

const mockFindUserByEmail = jest.fn<(email: string) => Promise<unknown>>();
const mockAdapterFindOne =
  jest.fn<(args: { model: string; where: { field: string; value: unknown }[] }) => Promise<unknown>>();
const mockAdapterCreate = jest.fn();

const mockAuthContext = {
  internalAdapter: { findUserByEmail: mockFindUserByEmail },
  adapter: { findOne: mockAdapterFindOne, create: mockAdapterCreate },
};

jest.mock('@wxyc/authentication', () => ({
  auth: { $context: Promise.resolve(mockAuthContext) },
}));

const mockProvisionUser = jest.fn();
jest.mock('../../../apps/auth/provision-user', () => ({
  provisionUser: (...args: unknown[]) => mockProvisionUser(...args),
}));

// --- Import after mocks ---
import { createDefaultUser } from '../../../apps/auth/create-default-user';

// --- Helpers ---
const fakeOrg = { id: 'default-org-id-000000000000001', slug: 'wxyc', name: 'WXYC' };

const ENV_KEYS = [
  'CREATE_DEFAULT_USER',
  'DEFAULT_USER_EMAIL',
  'DEFAULT_USER_USERNAME',
  'DEFAULT_USER_PASSWORD',
  'DEFAULT_USER_DJ_NAME',
  'DEFAULT_USER_REAL_NAME',
  'DEFAULT_ORG_SLUG',
  'DEFAULT_ORG_NAME',
] as const;

function setHappyEnv() {
  process.env.CREATE_DEFAULT_USER = 'TRUE';
  process.env.DEFAULT_USER_EMAIL = 'default@wxyc.org';
  process.env.DEFAULT_USER_USERNAME = 'test_dj1';
  process.env.DEFAULT_USER_PASSWORD = 'super-secret';
  process.env.DEFAULT_USER_DJ_NAME = 'DJ Default';
  process.env.DEFAULT_USER_REAL_NAME = 'Default User';
  process.env.DEFAULT_ORG_SLUG = 'wxyc';
  process.env.DEFAULT_ORG_NAME = 'WXYC';
}

// Route adapter.findOne by model: 'user' → username lookup, 'organization' → org.
function wireAdapter({ userByUsername }: { userByUsername: unknown }) {
  mockAdapterFindOne.mockImplementation(({ model }) =>
    Promise.resolve(model === 'user' ? userByUsername : model === 'organization' ? fakeOrg : null)
  );
}

describe('createDefaultUser()', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];

    jest.clearAllMocks();
    // Default happy adapter behavior: no existing user by email or username, org present.
    mockFindUserByEmail.mockResolvedValue(null);
    wireAdapter({ userByUsername: null });
    mockProvisionUser.mockResolvedValue({ user: { id: 'u1' }, member: { id: 'm1' }, emailSent: true });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('no-ops when CREATE_DEFAULT_USER is not TRUE', async () => {
    await createDefaultUser();
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
    expect(mockProvisionUser).not.toHaveBeenCalled();
  });

  it('provisions the default user when neither the email nor the username is taken', async () => {
    setHappyEnv();

    await createDefaultUser();

    expect(mockFindUserByEmail).toHaveBeenCalledWith('default@wxyc.org');
    // Username was checked before provisioning.
    expect(mockAdapterFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'user', where: [{ field: 'username', value: 'test_dj1' }] })
    );
    expect(mockProvisionUser).toHaveBeenCalledTimes(1);
    expect(mockProvisionUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'test_dj1', role: 'stationManager' })
    );
  });

  it('skips creation when the email already exists (existing behavior)', async () => {
    setHappyEnv();
    mockFindUserByEmail.mockResolvedValue({ id: 'existing-by-email' });

    await createDefaultUser();

    expect(mockProvisionUser).not.toHaveBeenCalled();
  });

  // BS#1670: the seeded e2e `test_dj1` owns the username under a different
  // email; the email lookup misses, so without the username guard a fresh
  // provision would trip `auth_user_username_key` mid-run.
  it('skips creation when the username is already taken under a different email (BS#1670)', async () => {
    setHappyEnv();
    // Email miss (configured email differs from the seeded row's email)...
    mockFindUserByEmail.mockResolvedValue(null);
    // ...but the username is already owned by a seeded row.
    wireAdapter({ userByUsername: { id: 'seeded-test-dj1-id' } });

    await createDefaultUser();

    expect(mockAdapterFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'user', where: [{ field: 'username', value: 'test_dj1' }] })
    );
    // No colliding INSERT.
    expect(mockProvisionUser).not.toHaveBeenCalled();
    expect(mockAdapterCreate).not.toHaveBeenCalled();
  });

  it('captures to Sentry (does not throw) when required env vars are missing', async () => {
    process.env.CREATE_DEFAULT_USER = 'TRUE'; // gate on, but no DEFAULT_USER_* set

    await expect(createDefaultUser()).resolves.toBeUndefined();

    expect(mockProvisionUser).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
  });
});
