import { jest } from '@jest/globals';

// --- Mocks ---

const mockFindUserByEmail = jest.fn<(email: string) => Promise<unknown>>();
const mockAdapterFindOne =
  jest.fn<(args: { model: string; where: { field: string; value: unknown }[] }) => Promise<unknown>>();

const mockAuthContext = {
  internalAdapter: { findUserByEmail: mockFindUserByEmail },
  adapter: { findOne: mockAdapterFindOne },
};

const mockMatchStationPasscode =
  jest.fn<
    (code: string, options?: unknown) => Promise<{ ok: boolean; cooldown: boolean; passcodeId: string | null }>
  >();
const mockClaimStationPasscode =
  jest.fn<(passcodeId: string, options?: unknown) => Promise<{ ok: boolean; cooldown: boolean }>>();
const mockSendVerificationEmailMessage = jest.fn<(args: { to: string; verificationUrl: string }) => Promise<void>>();

jest.mock('@wxyc/authentication', () => {
  // Real validator — exercise the production regex, same rationale as
  // provision-user.test.ts's identical wiring.
  const actual = jest.requireActual('../../../shared/authentication/src/auth.username');
  return {
    ...actual,
    auth: { $context: Promise.resolve(mockAuthContext) },
    matchStationPasscode: (...args: unknown[]) => mockMatchStationPasscode(...(args as [string, unknown])),
    claimStationPasscode: (...args: unknown[]) => mockClaimStationPasscode(...(args as [string, unknown])),
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

/** Neither phase of the passcode gate ran. */
function expectPasscodeUntouched() {
  expect(mockMatchStationPasscode).not.toHaveBeenCalled();
  expect(mockClaimStationPasscode).not.toHaveBeenCalled();
}

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
    mockMatchStationPasscode.mockResolvedValue({ ok: true, cooldown: false, passcodeId: 'passcode-id-001' });
    mockClaimStationPasscode.mockResolvedValue({ ok: true, cooldown: false });
    mockSendVerificationEmailMessage.mockResolvedValue(undefined);
    mockProvisionUser.mockResolvedValue({
      user: { id: 'user-id-001', email: VALID_BODY.email, username: VALID_BODY.username },
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
    // app.ts does not mount the route at all when the flag is off (so the
    // path falls through to better-auth's catch-all and looks like it never
    // existed); this covers the handler's own defence-in-depth guard.
    it('throws a 404 without touching the passcode, the DB, or provisionUser', async () => {
      delete process.env.STATION_SIGNUP_ENABLED;

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockFindUserByEmail).not.toHaveBeenCalled();
      expectPasscodeUntouched();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });
  });

  describe('validation ordering — the use-claim must never fire for a request rejected on unrelated grounds', () => {
    it('rejects a missing field before checking the passcode', async () => {
      const { realName: _realName, ...withoutRealName } = VALID_BODY;
      void _realName;

      await expect(stationSignupFromRequest(withoutRealName, undefined)).rejects.toBeInstanceOf(StationSignupError);
      expectPasscodeUntouched();
    });

    it('rejects an invalid username before checking the passcode', async () => {
      const body = { ...VALID_BODY, username: 'no' }; // below MIN_USERNAME_LENGTH

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expectPasscodeUntouched();
    });

    it('rejects an invalid email before checking the passcode', async () => {
      const body = { ...VALID_BODY, email: 'not-an-email' };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expectPasscodeUntouched();
    });

    it('rejects a too-short password before checking the passcode', async () => {
      const body = { ...VALID_BODY, password: 'short1' };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expectPasscodeUntouched();
    });

    // BS#2361 review, finding 4. Every one of these would otherwise reach
    // provisionUser AFTER a use was claimed and die on the column constraint
    // (or, for the password, on better-auth's own maxPasswordLength) with
    // the use already burned.
    it.each([
      ['email', 'email', `${'e'.repeat(250)}@test.wxyc.org`],
      ['realName', 'realName', 'R'.repeat(256)],
      ['djName', 'djName', 'D'.repeat(256)],
    ])('rejects an over-length %s before checking the passcode', async (_label, field, value) => {
      const body = { ...VALID_BODY, [field]: value };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expectPasscodeUntouched();
    });

    it('rejects an over-length password before checking the passcode', async () => {
      // better-auth's maxPasswordLength default is 128; 129 must not reach
      // provisionUser's hash step.
      const body = { ...VALID_BODY, password: 'p'.repeat(129) };

      await expect(stationSignupFromRequest(body, undefined)).rejects.toMatchObject({ statusCode: 400 });
      expectPasscodeUntouched();
    });

    it('accepts a password at exactly the 128-character ceiling', async () => {
      const body = { ...VALID_BODY, password: 'p'.repeat(128) };

      await expect(stationSignupFromRequest(body, undefined)).resolves.toMatchObject({ status: true });
    });

    it('rejects a duplicate email before CLAIMING a use (but after the passcode is matched)', async () => {
      mockFindUserByEmail.mockResolvedValue({ id: 'existing-user' });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockMatchStationPasscode).toHaveBeenCalledTimes(1);
      expect(mockClaimStationPasscode).not.toHaveBeenCalled();
    });

    it('rejects a duplicate username before CLAIMING a use (but after the passcode is matched)', async () => {
      mockAdapterFindOne.mockResolvedValue({ id: 'existing-user' });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockMatchStationPasscode).toHaveBeenCalledTimes(1);
      expect(mockClaimStationPasscode).not.toHaveBeenCalled();
    });
  });

  // BS#2361 review, finding 1. The existence checks used to run BEFORE the
  // passcode, which made this endpoint an unauthenticated
  // email-registration oracle: an attacker with a garbage code read
  // registration status straight off the status code.
  describe('the passcode gate runs before anything a caller can enumerate', () => {
    beforeEach(() => {
      mockMatchStationPasscode.mockResolvedValue({ ok: false, cooldown: false, passcodeId: null });
    });

    it('gives a bad passcode the same 401 whether the email is registered or not', async () => {
      const fresh = await stationSignupFromRequest(VALID_BODY, undefined).catch((error) => error);

      jest.clearAllMocks();
      mockMatchStationPasscode.mockResolvedValue({ ok: false, cooldown: false, passcodeId: null });
      mockFindUserByEmail.mockResolvedValue({ id: 'existing-user' });
      mockAdapterFindOne.mockResolvedValue({ id: 'existing-user' });
      const taken = await stationSignupFromRequest(VALID_BODY, undefined).catch((error) => error);

      expect(fresh).toBeInstanceOf(StationSignupError);
      expect({ statusCode: taken.statusCode, message: taken.message, code: taken.code }).toEqual({
        statusCode: fresh.statusCode,
        message: fresh.message,
        code: fresh.code,
      });
      expect(taken.statusCode).toBe(401);
    });

    it('never queries the user table at all for a bad passcode', async () => {
      mockFindUserByEmail.mockResolvedValue({ id: 'existing-user' });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 401 });
      expect(mockFindUserByEmail).not.toHaveBeenCalled();
      expect(mockAdapterFindOne).not.toHaveBeenCalled();
    });
  });

  describe('passcode verification result', () => {
    it('returns a generic 401 on an invalid/expired/revoked/exhausted code', async () => {
      mockMatchStationPasscode.mockResolvedValue({ ok: false, cooldown: false, passcodeId: null });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 401 });
      expect(mockClaimStationPasscode).not.toHaveBeenCalled();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('returns 429 with a wait-time message during cooldown', async () => {
      mockMatchStationPasscode.mockResolvedValue({ ok: false, cooldown: true, passcodeId: null });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({
        statusCode: 429,
      });
      expect(mockClaimStationPasscode).not.toHaveBeenCalled();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    // The accepted residual of splitting match from claim: the code reached
    // its cap / was revoked / expired in between. Same generic refusal.
    it('returns the same generic 401 when the claim loses the race after a good match', async () => {
      mockClaimStationPasscode.mockResolvedValue({ ok: false, cooldown: false });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({
        statusCode: 401,
        code: 'INVALID_PASSCODE',
      });
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('passes the raw client IP through to both phases', async () => {
      await stationSignupFromRequest(VALID_BODY, '203.0.113.5');
      expect(mockMatchStationPasscode).toHaveBeenCalledWith('WXYC2026', { rawClientIp: '203.0.113.5' });
      expect(mockClaimStationPasscode).toHaveBeenCalledWith('passcode-id-001', { rawClientIp: '203.0.113.5' });
    });
  });

  // BS#2361 review, finding 2. better-auth's username plugin lowercases on
  // store and duplicate-checks the lowercased value.
  describe('username case normalization', () => {
    it('lowercases the username for validation, the lookup, provisionUser, and the response', async () => {
      const result = await stationSignupFromRequest({ ...VALID_BODY, username: 'NewDJ' }, undefined);

      expect(mockAdapterFindOne).toHaveBeenCalledWith({
        model: 'user',
        where: [{ field: 'username', value: 'newdj' }],
      });
      const call = mockProvisionUser.mock.calls[0][0] as Record<string, unknown>;
      expect(call.username).toBe('newdj');
      expect(result.username).toBe(VALID_BODY.username);
    });

    it('catches a case-variant duplicate in the pre-check, without claiming a use', async () => {
      // Stored row is `newdj`; the caller submits `NewDJ`. Before
      // normalization the raw-case lookup missed this row entirely, the
      // request claimed a use, and better-auth's create hook then threw
      // "Username is already taken. Please try another." as a 500.
      mockAdapterFindOne.mockImplementation((args) =>
        Promise.resolve(
          args.where.some((clause) => clause.field === 'username' && clause.value === 'newdj')
            ? { id: 'existing-user' }
            : null
        )
      );

      await expect(stationSignupFromRequest({ ...VALID_BODY, username: 'NewDJ' }, undefined)).rejects.toMatchObject({
        statusCode: 409,
        code: 'USERNAME_TAKEN',
      });
      expect(mockClaimStationPasscode).not.toHaveBeenCalled();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('reads the username back off the created row rather than echoing the request', async () => {
      mockProvisionUser.mockResolvedValue({
        user: { id: 'user-id-001', email: 'stored@test.wxyc.org', username: 'stored_name' },
        member: { id: 'member-id-001', organizationId: 'org-id-001', role: 'dj' },
        emailSent: false,
      });

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).resolves.toEqual({
        status: true,
        userId: 'user-id-001',
        email: 'stored@test.wxyc.org',
        username: 'stored_name',
      });
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

    // BS#2361 review, finding 3. Checked after the claim (the shipped
    // order), a deploy with DEFAULT_ORG_SLUG unset burned one use per
    // attempt and bricked the code inside 25 requests.
    it('fails loudly when DEFAULT_ORG_SLUG is unset, before the passcode is even matched', async () => {
      delete process.env.DEFAULT_ORG_SLUG;

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toThrow(/DEFAULT_ORG_SLUG/);
      expectPasscodeUntouched();
      expect(mockProvisionUser).not.toHaveBeenCalled();
    });

    it('maps a ProvisionError (e.g. a race-lost duplicate) onto a StationSignupError with the same status', async () => {
      mockProvisionUser.mockRejectedValue(new FakeProvisionError(409, 'Username "new_dj" is already taken'));

      await expect(stationSignupFromRequest(VALID_BODY, undefined)).rejects.toMatchObject({ statusCode: 409 });
    });

    // Curated messages, never `error.message`: provisionUser's 404 embeds
    // DEFAULT_ORG_SLUG verbatim.
    it('never forwards a ProvisionError message that would leak server configuration', async () => {
      mockProvisionUser.mockRejectedValue(new FakeProvisionError(404, 'Organization not found for slug: "wxyc-prod"'));

      const error = await stationSignupFromRequest(VALID_BODY, undefined).catch((e) => e);
      expect(error).toBeInstanceOf(StationSignupError);
      expect(error.statusCode).toBe(500);
      expect(error.message).not.toMatch(/wxyc-prod/);
      expect(error.message).not.toMatch(/slug/i);
    });

    it('does not echo the raced-duplicate message verbatim either', async () => {
      mockProvisionUser.mockRejectedValue(
        new FakeProvisionError(409, 'User with email "newdj@test.wxyc.org" already exists')
      );

      const error = await stationSignupFromRequest(VALID_BODY, undefined).catch((e) => e);
      expect(error.statusCode).toBe(409);
      expect(error.message).not.toMatch(/newdj@test\.wxyc\.org/);
    });
  });
});
