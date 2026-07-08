import { jest } from '@jest/globals';

const mockFindVerificationValue = jest.fn();
const mockDeleteVerificationByIdentifier = jest.fn();
const mockUpdatePassword = jest.fn();
const mockUpdateUser = jest.fn();
const mockFindUserById = jest.fn();
const mockPasswordHash = jest.fn();
const mockGetSession = jest.fn();

const mockAuthContext = {
  internalAdapter: {
    findVerificationValue: mockFindVerificationValue,
    deleteVerificationByIdentifier: mockDeleteVerificationByIdentifier,
    updatePassword: mockUpdatePassword,
    updateUser: mockUpdateUser,
    findUserById: mockFindUserById,
  },
  password: {
    hash: mockPasswordHash,
    config: { minPasswordLength: 8, maxPasswordLength: 128 },
  },
};

jest.mock('@wxyc/authentication', () => ({
  auth: {
    $context: Promise.resolve(mockAuthContext),
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

import { CompleteOnboardingError, completeOnboarding } from '../../../apps/auth/complete-onboarding';

const future = new Date(Date.now() + 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockPasswordHash.mockResolvedValue('hashed-password' as never);
  mockFindVerificationValue.mockResolvedValue({
    value: 'user-id-001',
    expiresAt: future,
  } as never);
  mockFindUserById.mockResolvedValue({
    id: 'user-id-001',
    hasCompletedOnboarding: false,
  } as never);
  mockUpdatePassword.mockResolvedValue(undefined as never);
  mockUpdateUser.mockResolvedValue(undefined as never);
  mockDeleteVerificationByIdentifier.mockResolvedValue(undefined as never);
});

describe('completeOnboarding()', () => {
  it('sets password, profile, and completion flag via setup token', async () => {
    const result = await completeOnboarding({
      token: 'setup-token-abc',
      newPassword: 'NewPassword1',
      realName: 'Jane Doe',
      djName: 'DJ Jane',
    });

    expect(result).toEqual({ status: true, userId: 'user-id-001' });
    expect(mockFindVerificationValue).toHaveBeenCalledWith('reset-password:setup-token-abc');
    expect(mockPasswordHash).toHaveBeenCalledWith('NewPassword1');
    expect(mockUpdatePassword).toHaveBeenCalledWith('user-id-001', 'hashed-password');
    expect(mockDeleteVerificationByIdentifier).toHaveBeenCalledWith('reset-password:setup-token-abc');
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-id-001',
      expect.objectContaining({
        hasCompletedOnboarding: true,
        realName: 'Jane Doe',
        djName: 'DJ Jane',
      })
    );
  });

  it('rejects expired setup tokens', async () => {
    mockFindVerificationValue.mockResolvedValue({
      value: 'user-id-001',
      expiresAt: new Date(0),
    } as never);

    await expect(completeOnboarding({ token: 'expired-token', newPassword: 'NewPassword1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_TOKEN',
    });
  });

  it('rejects users who already completed onboarding', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'user-id-001',
      hasCompletedOnboarding: true,
    } as never);

    await expect(completeOnboarding({ token: 'setup-token-abc', newPassword: 'NewPassword1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ONBOARDING_ALREADY_COMPLETE',
    });
  });

  it('supports session fallback when no token is provided', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-id-001' } } as never);

    const result = await completeOnboarding({
      newPassword: 'NewPassword1',
      headers: new Headers({ cookie: 'session=test' }),
    });

    expect(result.userId).toBe('user-id-001');
    expect(mockGetSession).toHaveBeenCalled();
    expect(mockDeleteVerificationByIdentifier).not.toHaveBeenCalled();
  });

  it('rejects passwords shorter than the configured minimum', async () => {
    await expect(completeOnboarding({ token: 'setup-token-abc', newPassword: 'short1' })).rejects.toBeInstanceOf(
      CompleteOnboardingError
    );
  });
});
