import { jest } from '@jest/globals';

// --- Mocks ---

const mockFindUserByEmail = jest.fn<(email: string) => Promise<unknown>>();
const mockAdapterFindOne =
  jest.fn<(args: { model: string; where: { field: string; value: unknown }[] }) => Promise<unknown>>();

const mockAuthContext = {
  internalAdapter: { findUserByEmail: mockFindUserByEmail },
  adapter: { findOne: mockAdapterFindOne },
};

const mockVerifyStationPasscode =
  jest.fn<(code: string, options?: unknown) => Promise<{ ok: boolean; cooldown: boolean }>>();
const mockSendVerificationEmailMessage = jest.fn<(args: { to: string; verificationUrl: string }) => Promise<void>>();

jest.mock('@wxyc/authentication', () => {
  // Real validator — exercise the production regex, same rationale as
  // provision-user.test.ts's identical wiring.
  const actual = jest.requireActual('../../../shared/authentication/src/auth.username');
  return {
    ...actual,
    auth: { $context: Promise.resolve(mockAuthContext) },
    verifyStationPasscode: (...args: unknown[]) => mockVerifyStationPasscode(...(args as [string, unknown])),
    sendVerificationEmailMessage: (...args: unknown[]) =>
      mockSendVerificationEmailMessage(...(args as [{ to: string; verificationUrl: string }])),
    // The real value — the cooldown-refusal message does arithmetic against
    // it, and a stubbed constant would let that arithmetic drift silently.
    SIGNUP_COOLDOWN_HOLD_MS: 15 * 60 * 1000,
  };
});

const mockProvisionUser = jest.fn<(input: unknown) => Promise<unknown>>();

class FakeProvisionError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

jest.mock('../../../apps/auth/provision-user', () => ({
  provisionUser: (...args: unknown[]) => mockProvisionUser(...args),
  ProvisionError: FakeProvisionError,
}));

// --- Import after mocks ---
import {
  stationSignupFromRequest,
  isStationSignupEnabled,
  StationSignupError,
} from '../../../apps/auth/station-signup';

const VALID_BODY = {
  passcode: 'WXYC2026',
  username: 'new_dj',
  email: 'newdj@test.wxyc.org',
  password: 'supersecret1',
  realName: 'Jane Doe',
  djName: 'DJ Jazzy Jane',
};

const ENV_KEYS = ['STATION_SIGNUP_ENABLED', 'DEFAULT_ORG_SLUG', 'FRONTEND_SOURCE'] as const;

describe('station-signup', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.STATION_SIGNUP_ENABLED = 'true';
    process.env.DEFAULT_ORG_SLUG = 'test-org';
    process.env.FRONTEND_SOURCE = 'http://localhost:3000';

    jest.clearAllMocks();
    mockFindUserByEmail.mockResolvedValue(null);
    mockAdapterFindOne.mockResolvedValue(null);
    mockVerifyStationPasscode.mockResolvedValue({ ok: true, cooldown: false });
    mockSendVerificationEmailMessage.mockResolvedValue(undefined);
    mockProvisionUser.mockResolvedValue({
      user: { id: 'user-id-001', email: VALID_BODY.email },
      member: { id: 'member-id-001', organizationId: 'org-id-001', role: 'dj' },
      emailSent: false,
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('isStationSignupEnabled', () => {
    it('is false when unset', () => {
      delete process.env.STATION_SIGNUP_ENABLED;
      expect(isStationSignupEnabled()).toBe(false);
    });

    it('is false for anything other than the exact string "true"', () => {
      process.env.STATION_SIGNUP_ENABLED = 'TRUE';
      expect(isStationSignupEnabled()).toBe(false);
    });

    it('is true only for the exact string "true"', () => {
      process.env.STATION_SIGNUP_ENABLED = 'true';
      expect(isStationSignupEnabled()).toBe(true);
    });
  });

  describe('feature flag off', () => {
    it('throws a 404 without touching the passcode, the DB, or provisionUser', async () => {
      delete process.env.STATION_SIGNUP_ENABLED;

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockFindUserByEmail).not.toHaveBeenCalled();
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });
  });

  describe('validation ordering — the use-claim must never fire for a request rejected on unrelated grounds', () => {
    it('rejects a missing field before checking the passcode', async () => {
      const { passcode: _passcode, ...withoutRealName } = VALID_BODY;
      void _passcode;
      const body = { ...withoutRealName, realName: '' };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toBeInstanceOf(StationSignupError);
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
    });

    it('rejects an invalid username before checking the passcode', async () => {
      const body = { ...VALID_BODY, username: 'no' }; // below MIN_USERNAME_LENGTH

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
    });

    it('rejects an invalid email before checking the passcode', async () => {
      const body = { ...VALID_BODY, email: 'not-an-email' };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
    });

    it('rejects a too-short password before checking the passcode', async () => {
      const body = { ...VALID_BODY, password: 'short1' };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email before checking the passcode', async () => {
      mockFindUserByEmail.mockResolvedValue({ id: 'existing-user' });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
    });

    it('rejects a duplicate username before checking the passcode', async () => {
      mockAdapterFindOne.mockResolvedValue({ id: 'existing-user' });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockVerifyStationPasscode).not.toHaveBeenCalled();
    });
  });

  describe('passcode verification result', () => {
    it('returns a generic 401 on an invalid/expired/revoked/exhausted code', async () => {
      mockVerifyStationPasscode.mockResolvedValue({ ok: false, cooldown: false });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 401 });
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('returns 429 with a wait-time message during cooldown', async () => {
      mockVerifyStationPasscode.mockResolvedValue({ ok: false, cooldown: true });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({
        statusCode: 429,
      });
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('passes the raw client IP through to verifyStationPasscode', async () => {
      await stationSignupFromRequest(VALID_BODY, '203.0.113.5');
      expect(mockVerifyStationPasscode).toHaveBeenCalledWith('WXYC2026', { rawClientIp: '203.0.113.5' });
    });
  });

  describe('golden path', () => {
    it('provisions a dj-role account with server-pinned role/onboarding/selfSignupAt, sends no invite, and sends the verification probe', async () => {
      const result = await stationSignupFromRequest(VALID_BODY, undefined);

      expect(mockProvisionUser).toHaveBeenCalledTimes(1);
      const call = mockProvisionUser.mock.calls[0][0] as Record<string, unknown>;
      // Role is a server-side constant: the body carries no `role` field at
      // all, so this also proves a client can't smuggle one in.
      expect(call.role).toBe('dj');
      expect(call.sendSetupInvite).toBe(false);
      expect(call.hasCompletedOnboarding).toBe(true);
      expect(call.selfSignupAt).toBeInstanceOf(Date);
      expect(call.organizationSlug).toBe('test-org');
      expect(call.email).toBe(VALID_BODY.email);
      expect(call.username).toBe(VALID_BODY.username);
      expect(call.password).toBe(VALID_BODY.password);
      expect(call.realName).toBe(VALID_BODY.realName);
      expect(call.djName).toBe(VALID_BODY.djName);

      expect(mockSendVerificationEmailMessage).toHaveBeenCalledWith({
        to: VALID_BODY.email,
        verificationUrl: expect.stringContaining('/login'),
      });

      expect(result).toEqual({
        status: true,
        userId: 'user-id-001',
        email: VALID_BODY.email,
        username: VALID_BODY.username,
      });
    });

    it('a body-supplied role is ignored — the server constant always wins', async () => {
      const body = { ...VALID_BODY, role: 'stationManager' };

      await stationSignupFromRequest(body, undefined);

      const call = mockProvisionUser.mock.calls[0][0] as Record<string, unknown>;
      expect(call.role).toBe('dj');
    });

    it('still returns success when the verification probe send fails', async () => {
      mockSendVerificationEmailMessage.mockRejectedValue(new Error('SES down'));

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).resolves.toMatchObject({ status: true });
    });

    it('fails loudly when DEFAULT_ORG_SLUG is unset, without burning the already-claimed passcode use', async () => {
      delete process.env.DEFAULT_ORG_SLUG;

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toThrow(/DEFAULT_ORG_SLUG/);
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('maps a ProvisionError (e.g. a race-lost duplicate) onto a StationSignupError with the same status', async () => {
      mockProvisionUser.mockRejectedValue(new FakeProvisionError(409, 'Username "new_dj" is already taken'));

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 409 });
    });
  });
});
