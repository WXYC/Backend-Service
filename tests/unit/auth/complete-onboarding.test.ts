import { jest } from '@jest/globals';

const mockFindVerificationValue = jest.fn();
const mockUpdateUser = jest.fn();
const mockFindUserById = jest.fn();
const mockResetPassword = jest.fn();
const mockGetSession = jest.fn();

const mockAuthContext = {
  internalAdapter: {
    findVerificationValue: mockFindVerificationValue,
    updateUser: mockUpdateUser,
    findUserById: mockFindUserById,
  },
};

jest.mock('@wxyc/authentication', () => ({
  auth: {
    $context: Promise.resolve(mockAuthContext),
    api: {
      resetPassword: mockResetPassword,
      getSession: mockGetSession,
    },
  },
}));

import {
  CompleteOnboardingError,
  completeOnboardingFromRequest,
  completeOnboardingWithToken,
  completeOnboardingWithSession,
} from '../../../apps/auth/complete-onboarding';
import { APIError } from 'better-auth/api';

const future = new Date(Date.now() + 60_000);
const emptyHeaders = new Headers();

beforeEach(() => {
  jest.clearAllMocks();
  mockFindVerificationValue.mockResolvedValue({
    value: 'user-id-001',
    expiresAt: future,
  } as never);
  mockFindUserById.mockResolvedValue({
    id: 'user-id-001',
    email: 'dj@example.com',
    username: 'testdj',
    hasCompletedOnboarding: false,
  } as never);
  mockResetPassword.mockResolvedValue({ status: true } as never);
  mockUpdateUser.mockResolvedValue(undefined as never);
  mockGetSession.mockResolvedValue(null as never);
});

describe('completeOnboardingWithToken()', () => {
  it('sets the password via better-auth resetPassword and marks completion', async () => {
    const result = await completeOnboardingWithToken({
      token: 'setup-token-abc',
      newPassword: 'NewPassword1',
      realName: 'Jane Doe',
      djName: 'DJ Jane',
    });

    expect(result).toEqual({
      status: true,
      userId: 'user-id-001',
      email: 'dj@example.com',
      username: 'testdj',
    });
    expect(mockFindVerificationValue).toHaveBeenCalledWith('reset-password:setup-token-abc');
    expect(mockResetPassword).toHaveBeenCalledWith({
      body: { token: 'setup-token-abc', newPassword: 'NewPassword1' },
    });
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-id-001',
      expect.objectContaining({
        hasCompletedOnboarding: true,
        emailVerified: true,
        realName: 'Jane Doe',
        djName: 'DJ Jane',
      })
    );
  });

  it('rejects expired setup tokens before consuming them', async () => {
    mockFindVerificationValue.mockResolvedValue({
      value: 'user-id-001',
      expiresAt: new Date(0),
    } as never);

    await expect(
      completeOnboardingWithToken({ token: 'expired-token', newPassword: 'NewPassword1' })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_TOKEN',
    });
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('rejects users who already completed onboarding without burning the token', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'user-id-001',
      hasCompletedOnboarding: true,
    } as never);

    await expect(
      completeOnboardingWithToken({ token: 'setup-token-abc', newPassword: 'NewPassword1' })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ONBOARDING_ALREADY_COMPLETE',
    });
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('does not mark completion when resetPassword fails', async () => {
    mockResetPassword.mockRejectedValue(new Error('boom') as never);

    await expect(
      completeOnboardingWithToken({ token: 'setup-token-abc', newPassword: 'NewPassword1' })
    ).rejects.toThrow('boom');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('maps a better-auth APIError from resetPassword onto CompleteOnboardingError', async () => {
    mockResetPassword.mockRejectedValue(
      new APIError(400, { message: 'Invalid or expired token', code: 'INVALID_TOKEN' }) as never
    );

    await expect(
      completeOnboardingWithToken({ token: 'setup-token-abc', newPassword: 'NewPassword1' })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_TOKEN',
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('retries profile update after resetPassword and returns PROFILE_UPDATE_FAILED when update keeps failing', async () => {
    jest.useFakeTimers();
    mockUpdateUser.mockRejectedValue(new Error('db blip') as never);

    const pending = completeOnboardingWithToken({
      token: 'setup-token-abc',
      newPassword: 'NewPassword1',
      realName: 'Jane Doe',
    });

    await jest.runAllTimersAsync();

    await expect(pending).rejects.toMatchObject({
      statusCode: 503,
      code: 'PROFILE_UPDATE_FAILED',
    });
    expect(mockUpdateUser).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});

describe('completeOnboardingWithSession()', () => {
  it('marks completion for a signed-in incomplete user without touching the password', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-id-001' } } as never);

    const result = await completeOnboardingWithSession(emptyHeaders, {
      realName: 'Jane Doe',
      djName: 'DJ Jane',
    });

    expect(result).toEqual({
      status: true,
      userId: 'user-id-001',
      email: 'dj@example.com',
      username: 'testdj',
    });
    expect(mockResetPassword).not.toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-id-001',
      expect.objectContaining({
        hasCompletedOnboarding: true,
        realName: 'Jane Doe',
        djName: 'DJ Jane',
      })
    );
    const update = mockUpdateUser.mock.calls[0][1] as Record<string, unknown>;
    expect(update.emailVerified).toBeUndefined();
  });

  it('rejects anonymous sessions', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'anon-id', isAnonymous: true } } as never);

    await expect(completeOnboardingWithSession(emptyHeaders, { realName: 'Jane Doe' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects when there is no session', async () => {
    await expect(completeOnboardingWithSession(emptyHeaders, { realName: 'Jane Doe' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects a signed-in user who already completed onboarding', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-id-001' } } as never);
    mockFindUserById.mockResolvedValue({
      id: 'user-id-001',
      hasCompletedOnboarding: true,
    } as never);

    await expect(completeOnboardingWithSession(emptyHeaders, { realName: 'Jane Doe' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ONBOARDING_ALREADY_COMPLETE',
    });
  });
});

describe('completeOnboardingFromRequest()', () => {
  it('routes token requests to the token flow', async () => {
    const result = await completeOnboardingFromRequest(
      { token: 'setup-token-abc', newPassword: 'NewPassword1', realName: 'Jane Doe' },
      emptyHeaders
    );

    expect(result.userId).toBe('user-id-001');
    expect(mockResetPassword).toHaveBeenCalled();
  });

  it('requires newPassword when a token is supplied', async () => {
    await expect(completeOnboardingFromRequest({ token: 'setup-token-abc' }, emptyHeaders)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REQUEST',
    });
  });

  it('rejects a password without a token instead of silently ignoring it', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-id-001' } } as never);

    await expect(
      completeOnboardingFromRequest({ newPassword: 'NewPassword1', realName: 'Jane Doe' }, emptyHeaders)
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REQUEST',
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('routes tokenless requests to the session flow', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-id-001' } } as never);

    const result = await completeOnboardingFromRequest({ realName: 'Jane Doe' }, emptyHeaders);

    expect(result.userId).toBe('user-id-001');
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('is CompleteOnboardingError for unauthorized tokenless requests', async () => {
    await expect(completeOnboardingFromRequest({ realName: 'Jane Doe' }, emptyHeaders)).rejects.toBeInstanceOf(
      CompleteOnboardingError
    );
  });
});
