/**
 * Atomic onboarding completion for admin-provisioned DJs.
 *
 * Accepts either:
 *  - A setup token from the invite email (primary path; no session required), or
 *  - An authenticated session for an incomplete user (migration / edge cases).
 *
 * Sets the user's chosen password, optional profile fields, and flips
 * hasCompletedOnboarding in one operation.
 */

import { auth } from '@wxyc/authentication';
import { fromNodeHeaders } from 'better-auth/node';

export class CompleteOnboardingError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'CompleteOnboardingError';
  }
}

export interface CompleteOnboardingInput {
  token?: string;
  newPassword: string;
  realName?: string;
  djName?: string;
  /** Node request headers — required for the session fallback path. */
  headers?: Headers;
}

export interface CompleteOnboardingResult {
  status: true;
  userId: string;
}

const trimOptional = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

async function resolveUserIdFromToken(token: string): Promise<string> {
  const context = await auth.$context;
  const identifier = `reset-password:${token}`;
  const verification = await context.internalAdapter.findVerificationValue(identifier);

  if (!verification || verification.expiresAt < new Date()) {
    throw new CompleteOnboardingError(400, 'Invalid or expired setup token', 'INVALID_TOKEN');
  }

  return verification.value;
}

async function assertIncompleteUser(userId: string): Promise<{ id: string; hasCompletedOnboarding?: boolean }> {
  const context = await auth.$context;
  const userRecord = await context.internalAdapter.findUserById(userId);
  if (!userRecord) {
    throw new CompleteOnboardingError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const hasCompletedOnboarding = (userRecord as { hasCompletedOnboarding?: boolean }).hasCompletedOnboarding;
  if (hasCompletedOnboarding === true) {
    throw new CompleteOnboardingError(400, 'Onboarding already completed', 'ONBOARDING_ALREADY_COMPLETE');
  }

  return userRecord as { id: string; hasCompletedOnboarding?: boolean };
}

export async function completeOnboarding(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
  const { token, newPassword, realName, djName, headers } = input;
  const context = await auth.$context;

  const minLength = context.password?.config?.minPasswordLength ?? 8;
  const maxLength = context.password?.config?.maxPasswordLength ?? 128;

  if (typeof newPassword !== 'string' || newPassword.length < minLength) {
    throw new CompleteOnboardingError(400, `Password must be at least ${minLength} characters`, 'PASSWORD_TOO_SHORT');
  }
  if (newPassword.length > maxLength) {
    throw new CompleteOnboardingError(400, `Password must be at most ${maxLength} characters`, 'PASSWORD_TOO_LONG');
  }

  let userId: string;
  let verificationIdentifier: string | undefined;

  if (token) {
    userId = await resolveUserIdFromToken(token);
    verificationIdentifier = `reset-password:${token}`;
  } else if (headers) {
    const session = await auth.api.getSession({ headers });
    if (!session?.user?.id) {
      throw new CompleteOnboardingError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    userId = session.user.id;
  } else {
    throw new CompleteOnboardingError(400, 'Setup token or authenticated session required', 'INVALID_REQUEST');
  }

  await assertIncompleteUser(userId);

  const hashedPassword = await context.password.hash(newPassword);
  await context.internalAdapter.updatePassword(userId, hashedPassword);

  if (verificationIdentifier) {
    await context.internalAdapter.deleteVerificationByIdentifier(verificationIdentifier);
  }

  const profileUpdate: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    updatedAt: new Date(),
  };
  const trimmedRealName = trimOptional(realName);
  const trimmedDjName = trimOptional(djName);
  if (trimmedRealName) profileUpdate.realName = trimmedRealName;
  if (trimmedDjName) profileUpdate.djName = trimmedDjName;

  await context.internalAdapter.updateUser(userId, profileUpdate);

  return { status: true, userId };
}

export async function completeOnboardingFromRequest(
  body: Record<string, unknown>,
  headers: Headers
): Promise<CompleteOnboardingResult> {
  const token = typeof body.token === 'string' ? body.token.trim() : undefined;
  const newPassword = body.newPassword;

  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    throw new CompleteOnboardingError(400, 'newPassword is required', 'INVALID_REQUEST');
  }

  return completeOnboarding({
    token: token || undefined,
    newPassword,
    realName: trimOptional(body.realName),
    djName: trimOptional(body.djName),
    headers,
  });
}

/** Express-compatible header bag → Headers for better-auth session lookup. */
export function headersFromExpress(req: { headers: Record<string, string | string[] | undefined> }): Headers {
  return fromNodeHeaders(req.headers);
}
