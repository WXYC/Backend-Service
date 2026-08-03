import { jest } from '@jest/globals';

// --- Mocks ---

// Mock the auth instance so we don't load the whole better-auth stack; expose a
// $context with just the internalAdapter method + baseURL the helper reads.
const mockCreateVerificationValue = jest.fn().mockResolvedValue(undefined as never);
const mockContext = {
  baseURL: 'https://api.wxyc.org/auth',
  internalAdapter: {
    createVerificationValue: (...args: unknown[]) => mockCreateVerificationValue(...args),
  },
};
jest.mock('../../../shared/authentication/src/auth.definition', () => ({
  auth: { $context: Promise.resolve(mockContext) },
}));

const mockSendAccountSetupEmail = jest.fn().mockResolvedValue(undefined as never);
jest.mock('../../../shared/authentication/src/email', () => ({
  sendAccountSetupEmail: (...args: unknown[]) => mockSendAccountSetupEmail(...args),
}));

const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

// --- Import after mocks (url-rewrite + account-setup-token are real leaves) ---
import { createAndSendAccountSetupInvite } from '../../../shared/authentication/src/account-setup';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const input = {
  userId: 'user-id-001',
  email: 'newdj@test.wxyc.org',
  redirectTo: 'https://dj.wxyc.org/onboarding',
};

describe('createAndSendAccountSetupInvite()', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN;
    delete process.env.PASSWORD_RESET_REDIRECT_URL;
    process.env.FRONTEND_SOURCE = 'https://dj.wxyc.org';
    mockCreateVerificationValue.mockResolvedValue(undefined as never);
    mockSendAccountSetupEmail.mockResolvedValue(undefined as never);
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('mints a reset-password verification row bound to the user with the 7-day default TTL', async () => {
    const before = Date.now();
    await createAndSendAccountSetupInvite(input);
    const after = Date.now();

    expect(mockCreateVerificationValue).toHaveBeenCalledTimes(1);
    const arg = mockCreateVerificationValue.mock.calls[0][0] as {
      identifier: string;
      value: string;
      expiresAt: Date;
    };
    expect(arg.identifier).toMatch(/^reset-password:[A-Za-z0-9_-]{20,}$/);
    expect(arg.value).toBe(input.userId);
    const ttlMs = arg.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(SEVEN_DAYS_MS - 1000);
    expect(ttlMs).toBeLessThanOrEqual(after - before + SEVEN_DAYS_MS + 1000);
  });

  it('honors an ACCOUNT_SETUP_TOKEN_EXPIRES_IN override', async () => {
    process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN = '3600';
    const before = Date.now();
    await createAndSendAccountSetupInvite(input);

    const arg = mockCreateVerificationValue.mock.calls[0][0] as { expiresAt: Date };
    const ttlMs = arg.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
    expect(ttlMs).toBeLessThanOrEqual(3600 * 1000 + 5000);
  });

  it('emails a frontend-host setup link carrying the token and the onboarding callback', async () => {
    await createAndSendAccountSetupInvite(input);

    expect(mockSendAccountSetupEmail).toHaveBeenCalledTimes(1);
    const call = mockSendAccountSetupEmail.mock.calls[0][0] as { to: string; setupUrl: string };
    expect(call.to).toBe(input.email);

    const parsed = new URL(call.setupUrl);
    // rewritten from the api host to the frontend host
    expect(parsed.host).toBe('dj.wxyc.org');
    // the emailed link carries the exact token that was minted
    const token = (mockCreateVerificationValue.mock.calls[0][0] as { identifier: string }).identifier.split(
      'reset-password:'
    )[1];
    expect(parsed.pathname).toBe(`/auth/reset-password/${token}`);
    // callbackURL is decoded by URLSearchParams — round-trips to the onboarding page
    expect(parsed.searchParams.get('callbackURL')).toBe(input.redirectTo);
  });

  it('appends redirectTo when PASSWORD_RESET_REDIRECT_URL is set', async () => {
    process.env.PASSWORD_RESET_REDIRECT_URL = 'https://dj.wxyc.org/reset';
    await createAndSendAccountSetupInvite(input);

    const call = mockSendAccountSetupEmail.mock.calls[0][0] as { setupUrl: string };
    const parsed = new URL(call.setupUrl);
    expect(parsed.searchParams.get('redirectTo')).toBe('https://dj.wxyc.org/reset');
  });

  it('returns { sent: true } and does not touch Sentry on a successful send', async () => {
    await expect(createAndSendAccountSetupInvite(input)).resolves.toEqual({ sent: true });
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });

  it('captures to Sentry and returns { sent: false, error } when the send throws', async () => {
    mockSendAccountSetupEmail.mockRejectedValue(new Error('SES throttled') as never);

    const result = await createAndSendAccountSetupInvite(input);

    expect(result).toEqual({ sent: false, error: 'SES throttled' });
    // observability regression-guard: dropping the capture must fail loudly
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { subsystem: 'account-setup-invite' },
        extra: { userId: input.userId, email: input.email },
      })
    );
  });

  it('mints the token before the send, so a bounce still leaves a usable link', async () => {
    mockSendAccountSetupEmail.mockRejectedValue(new Error('SES down') as never);
    await createAndSendAccountSetupInvite(input);
    expect(mockCreateVerificationValue).toHaveBeenCalledTimes(1);
  });

  it('returns { sent: false, error } without throwing when minting the token fails', async () => {
    // provisionUser calls this inside its user-cleanup try block, so a throw
    // here would roll back the just-provisioned user. A mint failure must be
    // swallowed to sent:false (never thrown), exactly like a send failure.
    mockCreateVerificationValue.mockRejectedValue(new Error('verification insert failed') as never);

    const result = await createAndSendAccountSetupInvite(input);

    expect(result).toEqual({ sent: false, error: 'verification insert failed' });
    expect(mockSendAccountSetupEmail).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { subsystem: 'account-setup-invite' },
        extra: { userId: input.userId, email: input.email },
      })
    );
  });
});
