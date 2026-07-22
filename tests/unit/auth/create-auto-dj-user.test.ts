import { jest } from '@jest/globals';

// --- Mocks ---

const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

const mockFindUserByEmail = jest.fn();
const mockAdapterFindOne = jest.fn();

const mockAuthContext = {
  internalAdapter: { findUserByEmail: mockFindUserByEmail },
  adapter: { findOne: mockAdapterFindOne },
};

jest.mock('@wxyc/authentication', () => ({
  auth: { $context: Promise.resolve(mockAuthContext) },
}));

const mockProvisionUser = jest.fn();
jest.mock('../../../apps/auth/provision-user', () => ({
  provisionUser: (...args: unknown[]) => mockProvisionUser(...args),
}));

// --- Import after mocks ---
import { createAutoDjUser } from '../../../apps/auth/create-auto-dj-user';

// --- Helpers ---
const fakeOrg = { id: 'default-org-id-000000000000001', slug: 'wxyc', name: 'WXYC' };

const ENV_KEYS = ['CREATE_AUTO_DJ_USER', 'AUTO_DJ_EMAIL', 'AUTO_DJ_PASSWORD', 'DEFAULT_ORG_SLUG'] as const;

function setHappyEnv() {
  process.env.CREATE_AUTO_DJ_USER = 'TRUE';
  process.env.AUTO_DJ_EMAIL = 'auto-dj@wxyc.org';
  process.env.AUTO_DJ_PASSWORD = 'super-secret-per-env-value';
  process.env.DEFAULT_ORG_SLUG = 'wxyc';
}

describe('createAutoDjUser()', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];

    jest.clearAllMocks();
    // Default happy adapter behavior: no existing user, org present.
    mockFindUserByEmail.mockResolvedValue(null);
    mockAdapterFindOne.mockResolvedValue(fakeOrg);
    mockProvisionUser.mockResolvedValue({ user: { id: 'u1' }, member: { id: 'm1' }, emailSent: true });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('boot flag gate', () => {
    it('does nothing when CREATE_AUTO_DJ_USER is unset (default off)', async () => {
      await createAutoDjUser();

      expect(mockFindUserByEmail).not.toHaveBeenCalled();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('does nothing when CREATE_AUTO_DJ_USER is set to a non-TRUE value', async () => {
      setHappyEnv();
      process.env.CREATE_AUTO_DJ_USER = 'true'; // case-sensitive, must be exactly "TRUE"

      await createAutoDjUser();

      expect(mockProvisionUser).not.toHaveBeenCalled();
    });
  });

  describe('missing env', () => {
    it.each(['AUTO_DJ_EMAIL', 'AUTO_DJ_PASSWORD', 'DEFAULT_ORG_SLUG'])(
      'captures to Sentry and does not provision when %s is missing',
      async (missing) => {
        setHappyEnv();
        delete process.env[missing];

        await createAutoDjUser();

        expect(mockProvisionUser).not.toHaveBeenCalled();
        expect(mockSentryCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ tags: { subsystem: 'auto-dj-user' } })
        );
      }
    );
  });

  describe('idempotency', () => {
    it('skips provisioning when the auto-dj user already exists', async () => {
      setHappyEnv();
      mockFindUserByEmail.mockResolvedValue({ id: 'existing', email: 'auto-dj@wxyc.org' });

      await createAutoDjUser();

      expect(mockFindUserByEmail).toHaveBeenCalledWith('auto-dj@wxyc.org');
      expect(mockProvisionUser).not.toHaveBeenCalled();
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('missing organization', () => {
    it('skips gracefully (no throw, no provision) when the default org does not exist', async () => {
      setHappyEnv();
      mockAdapterFindOne.mockResolvedValue(null);

      await createAutoDjUser();

      expect(mockProvisionUser).not.toHaveBeenCalled();
      // A missing org is a defensive skip, not an error — do not page on it.
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('provisions auto-dj@wxyc.org with the dj role and the "Auto DJ" handle', async () => {
      setHappyEnv();

      await createAutoDjUser();

      expect(mockProvisionUser).toHaveBeenCalledWith({
        email: 'auto-dj@wxyc.org',
        username: 'autodj',
        name: 'Auto DJ',
        djName: 'Auto DJ',
        organizationSlug: 'wxyc',
        role: 'dj',
        password: 'super-secret-per-env-value',
      });
    });

    it('does not pass realName (service account has no legal person)', async () => {
      setHappyEnv();

      await createAutoDjUser();

      const arg = mockProvisionUser.mock.calls[0][0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('realName');
    });

    it('requests exactly the dj role (least privilege — never admin/stationManager)', async () => {
      setHappyEnv();

      await createAutoDjUser();

      const arg = mockProvisionUser.mock.calls[0][0] as { role: string };
      expect(arg.role).toBe('dj');
    });
  });

  describe('provision failure', () => {
    it('captures to Sentry and does not rethrow when provisionUser fails', async () => {
      setHappyEnv();
      mockProvisionUser.mockRejectedValue(new Error('user already exists'));

      await expect(createAutoDjUser()).resolves.toBeUndefined();

      expect(mockSentryCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { subsystem: 'auto-dj-user' } })
      );
    });
  });
});
