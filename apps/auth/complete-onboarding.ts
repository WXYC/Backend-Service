/**
 * Atomic onboarding completion for admin-provisioned DJs.
 *
 * Requires a setup token from the invite email. Sets the user's chosen password,
 * optional profile fields, and flips hasCompletedOnboarding in one operation.
 */

import { auth } from '@wxyc/authentication';
import type { IncomingHttpHeaders } from 'node:http';
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
  token: string;
  newPassword: string;
  realName?: string;
  djName?: string;
}

export interface CompleteOnboardingResult {
  status: true;
  userId: string;
  email: string;
  username?: string;
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

type IncompleteUserRecord = {
  id: string;
  email: string;
  username?: string;
  hasCompletedOnboarding?: boolean;
};

async function assertIncompleteUser(userId: string): Promise<IncompleteUserRecord> {
  const context = await auth.$context;
  const userRecord = await context.internalAdapter.findUserById(userId);
  if (!userRecord) {
    throw new CompleteOnboardingError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const user = userRecord as IncompleteUserRecord;
  if (user.hasCompletedOnboarding === true) {
    throw new CompleteOnboardingError(400, 'Onboarding already completed', 'ONBOARDING_ALREADY_COMPLETE');
  }

  return user;
}

export async function completeOnboarding(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
  const { token, newPassword, realName, djName } = input;
  const context = await auth.$context;

  const minLength = context.password?.config?.minPasswordLength ?? 8;
  const maxLength = context.password?.config?.maxPasswordLength ?? 128;

  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new CompleteOnboardingError(400, 'Setup token is required', 'INVALID_REQUEST');
  }

  if (typeof newPassword !== 'string' || newPassword.length < minLength) {
    throw new CompleteOnboardingError(400, `Password must be at least ${minLength} characters`, 'PASSWORD_TOO_SHORT');
  }
  if (newPassword.length > maxLength) {
    throw new CompleteOnboardingError(400, `Password must be at most ${maxLength} characters`, 'PASSWORD_TOO_LONG');
  }

  const userId = await resolveUserIdFromToken(token.trim());
  const verificationIdentifier = `reset-password:${token.trim()}`;

  const user = await assertIncompleteUser(userId);

  const hashedPassword = await context.password.hash(newPassword);
  await context.internalAdapter.updatePassword(userId, hashedPassword);
  await context.internalAdapter.deleteVerificationByIdentifier(verificationIdentifier);

  const profileUpdate: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    updatedAt: new Date(),
  };
  const trimmedRealName = trimOptional(realName);
  const trimmedDjName = trimOptional(djName);
  if (trimmedRealName) profileUpdate.realName = trimmedRealName;
  if (trimmedDjName) profileUpdate.djName = trimmedDjName;

  await context.internalAdapter.updateUser(userId, profileUpdate);

  return {
    status: true,
    userId: user.id,
    email: user.email,
    username: user.username,
  };
}

export async function completeOnboardingFromRequest(body: Record<string, unknown>): Promise<CompleteOnboardingResult> {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const newPassword = body.newPassword;

  if (!token) {
    throw new CompleteOnboardingError(400, 'Setup token is required', 'INVALID_REQUEST');
  }
  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    throw new CompleteOnboardingError(400, 'newPassword is required', 'INVALID_REQUEST');
  }

  return completeOnboarding({
    token,
    newPassword,
    realName: trimOptional(body.realName),
    djName: trimOptional(body.djName),
  });
}

type SignInApi = {
  signInEmail: (input: {
    body: { email: string; password: string };
    headers: Headers;
    asResponse: true;
  }) => Promise<Response>;
  signInUsername: (input: {
    body: { username: string; password: string };
    headers: Headers;
    asResponse: true;
  }) => Promise<Response>;
};

/**
 * Sign the onboarded user in on the same HTTP response so session cookies
 * reach the browser without a separate client sign-in round trip.
 */
export async function establishPostOnboardingSession(
  input: { email: string; username?: string; password: string },
  requestHeaders: IncomingHttpHeaders
): Promise<string[]> {
  const api = auth.api as unknown as SignInApi;
  const headers = fromNodeHeaders(requestHeaders);

  const attempts: Array<() => Promise<Response>> = [];
  const trimmedUsername = input.username?.trim();
  const trimmedEmail = input.email.trim();

  if (trimmedUsername) {
    attempts.push(() =>
      api.signInUsername({
        body: { username: trimmedUsername, password: input.password },
        headers,
        asResponse: true,
      })
    );
  }
  if (trimmedEmail) {
    attempts.push(() =>
      api.signInEmail({
        body: { email: trimmedEmail, password: input.password },
        headers,
        asResponse: true,
      })
    );
  }

  for (const attempt of attempts) {
    const response = await attempt();
    if (response.ok) {
      return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    }
  }

  return [];
}
