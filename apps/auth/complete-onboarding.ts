/**
 * Onboarding completion for admin-provisioned DJs.
 *
 * Two entry modes:
 * - Invite token (the reset-password token from the invite email): sets the
 *   chosen password through better-auth's own `resetPassword` endpoint —
 *   which consumes the token, hashes, and runs the configured hooks — then
 *   records profile fields and flips `hasCompletedOnboarding`.
 * - Authenticated session: an incomplete user who is already signed in (e.g.
 *   set a password via the forgot-password flow before onboarding) only
 *   records profile fields and flips the flag. No password change.
 *
 * The invite-token path is intentionally two-phase: `resetPassword` consumes
 * the token before profile fields are written. A transient failure on the
 * profile update is retried; if it still fails the client receives a
 * distinguishable error steering them to sign in and finish via session mode.
 */

import { auth } from '@wxyc/authentication';
import type { User } from '@wxyc/database';
import { APIError } from 'better-auth/api';

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

export interface CompleteOnboardingResult {
  status: true;
  userId: string;
  email: string;
  username?: string;
}

type IncompleteUserRecord = Pick<User, 'id' | 'email' | 'username' | 'hasCompletedOnboarding'>;

const MARK_ONBOARDING_COMPLETE_ATTEMPTS = 3;
const MARK_ONBOARDING_COMPLETE_DELAY_MS = 100;

const trimOptional = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

function toCompleteOnboardingResult(user: IncompleteUserRecord): CompleteOnboardingResult {
  return {
    status: true,
    userId: user.id,
    email: user.email,
    username: user.username ?? undefined,
  };
}

/**
 * Resolve the user id bound to a setup/reset token.
 *
 * better-auth 1.6.20 stores password-reset tokens as verification rows with
 * identifier `reset-password:${token}` and value = userId. This is an
 * internal storage contract — a better-auth bump that changes the prefix or
 * encoding would invalidate invite tokens until this lookup is updated.
 */
async function resolveUserIdFromToken(token: string): Promise<string> {
  const context = await auth.$context;
  const identifier = `reset-password:${token}`;
  const verification = await context.internalAdapter.findVerificationValue(identifier);

  if (!verification || verification.expiresAt < new Date()) {
    throw new CompleteOnboardingError(400, 'Invalid or expired setup token', 'INVALID_TOKEN');
  }

  return verification.value;
}

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

async function markOnboardingComplete(
  userId: string,
  fields: { realName?: string; djName?: string; emailVerified?: boolean }
): Promise<void> {
  const context = await auth.$context;
  const update: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    updatedAt: new Date(),
  };
  if (fields.realName) update.realName = fields.realName;
  if (fields.djName) update.djName = fields.djName;
  if (fields.emailVerified) update.emailVerified = true;

  for (let attempt = 1; attempt <= MARK_ONBOARDING_COMPLETE_ATTEMPTS; attempt++) {
    try {
      await context.internalAdapter.updateUser(userId, update);
      return;
    } catch {
      if (attempt === MARK_ONBOARDING_COMPLETE_ATTEMPTS) {
        throw new CompleteOnboardingError(
          503,
          'Your password was set but we could not finish setup. Sign in at /login?incomplete=true to complete your profile.',
          'PROFILE_UPDATE_FAILED'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, MARK_ONBOARDING_COMPLETE_DELAY_MS));
    }
  }
}

export interface CompleteOnboardingTokenInput {
  token: string;
  newPassword: string;
  realName?: string;
  djName?: string;
}

/**
 * Invite-token completion. Asserts the token belongs to a not-yet-onboarded
 * user before consuming it, so a completed user's ordinary password-reset
 * token can never be burned (or their profile rewritten) through this
 * endpoint. The password itself is set by better-auth's `resetPassword`,
 * keeping hashing, token consumption, and `onPasswordReset` on the supported
 * surface. Using the emailed token proves mailbox ownership, so the account
 * is also marked email-verified — without this, `requireEmailVerification`
 * would block the very first sign-in after onboarding.
 */
export async function completeOnboardingWithToken(
  input: CompleteOnboardingTokenInput
): Promise<CompleteOnboardingResult> {
  const { newPassword, realName, djName } = input;
  const token = input.token.trim();

  const userId = await resolveUserIdFromToken(token);
  const user = await assertIncompleteUser(userId);

  try {
    await auth.api.resetPassword({ body: { token, newPassword } });
  } catch (error) {
    if (error instanceof APIError) {
      throw new CompleteOnboardingError(
        error.statusCode ?? 400,
        error.body?.message ?? 'Invalid or expired setup token',
        typeof error.body?.code === 'string' ? error.body.code : 'INVALID_TOKEN'
      );
    }
    throw error;
  }

  await markOnboardingComplete(userId, { realName, djName, emailVerified: true });

  return toCompleteOnboardingResult(user);
}

/**
 * Session completion for a signed-in incomplete user (the `/login?incomplete=true`
 * form). They authenticated with a password they already know, so only profile
 * fields and the completion flag change.
 */
export async function completeOnboardingWithSession(
  headers: Headers,
  input: { realName?: string; djName?: string }
): Promise<CompleteOnboardingResult> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    throw new CompleteOnboardingError(401, 'Sign in or use your invite link to complete onboarding', 'UNAUTHORIZED');
  }

  if ((session.user as { isAnonymous?: boolean }).isAnonymous) {
    throw new CompleteOnboardingError(
      403,
      'Anonymous sessions cannot complete onboarding',
      'FORBIDDEN'
    );
  }

  const user = await assertIncompleteUser(session.user.id);

  await markOnboardingComplete(user.id, { realName: input.realName, djName: input.djName });

  return toCompleteOnboardingResult(user);
}

export async function completeOnboardingFromRequest(
  body: Record<string, unknown>,
  headers: Headers
): Promise<CompleteOnboardingResult> {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const newPassword = body.newPassword;
  const realName = trimOptional(body.realName);
  const djName = trimOptional(body.djName);

  if (token) {
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      throw new CompleteOnboardingError(400, 'newPassword is required', 'INVALID_REQUEST');
    }
    return completeOnboardingWithToken({ token, newPassword, realName, djName });
  }

  // Reject a password without a token instead of silently ignoring it — a
  // client that thinks it set a password must not be told onboarding succeeded.
  if (typeof newPassword === 'string' && newPassword.length > 0) {
    throw new CompleteOnboardingError(
      400,
      'Setting a password requires the setup token from your invite email',
      'INVALID_REQUEST'
    );
  }

  return completeOnboardingWithSession(headers, { realName, djName });
}
