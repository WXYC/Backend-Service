import * as Sentry from '@sentry/node';
import { randomBytes } from 'node:crypto';
import { auth } from './auth.definition';
import { sendAccountSetupEmail } from './email';
import { buildResetUrl } from './url-rewrite';
import { accountSetupTokenExpiresInSeconds } from './account-setup-token';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface AccountSetupInviteInput {
  userId: string;
  email: string;
  /**
   * Frontend page the reset callback lands on, e.g. `${FRONTEND_SOURCE}/onboarding`.
   * Becomes the `callbackURL` on the emailed link, exactly as
   * `requestPasswordReset`'s `redirectTo` does.
   */
  redirectTo: string;
}

export interface AccountSetupInviteResult {
  /** Whether the SES send succeeded. `false` means the account exists but the email did not go out. */
  sent: boolean;
  /** Present when `sent` is false. */
  error?: string;
}

/**
 * Mint a long-lived account-setup token and email the DJ a setup link.
 *
 * Unlike a password reset (better-auth's `requestPasswordReset`, hardcoded to a
 * 1-hour TTL), an onboarding invite is acted on hours-to-days later, so this
 * mints its own token with `accountSetupTokenExpiresInSeconds()` (default 7
 * days — BS#1969). It reuses better-auth's `reset-password:<token>` verification
 * identifier so the entire downstream pipeline — the `GET /reset-password/:token`
 * redirect and `complete-onboarding`'s `resetPassword` consumption — stays
 * byte-identical; only the TTL and the (awaited, observable) send differ.
 *
 * The URL is built from `auth.$context.baseURL` (not `process.env` directly) so
 * it matches the link the `sendResetPassword` hook produces even if
 * `BETTER_AUTH_URL` is ever unset.
 *
 * The SES send is awaited so callers (`provisionUser`, CSV import) report an
 * accurate `emailSent`. Every failure path — resolving the auth context,
 * minting the token, or the send itself — is captured to Sentry and returned as
 * `{ sent: false }`, NEVER thrown: `provisionUser` calls this inside its
 * user-cleanup try block, so a throw here would roll back the just-provisioned
 * user instead of leaving it in place for an admin resend from the roster.
 */
export async function createAndSendAccountSetupInvite(
  input: AccountSetupInviteInput
): Promise<AccountSetupInviteResult> {
  const { userId, email, redirectTo } = input;

  try {
    const context = await auth.$context;

    // URL-path-safe opaque token (base64url: no `/`, `+`, or `=`). Format differs
    // from better-auth's own generateId(24) reset tokens but that is irrelevant —
    // the GET redirect and complete-onboarding match on the exact string.
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + accountSetupTokenExpiresInSeconds() * 1000);
    await context.internalAdapter.createVerificationValue({
      value: userId,
      identifier: `reset-password:${token}`,
      expiresAt,
    });

    const rawUrl = `${context.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(redirectTo)}`;
    const setupUrl = buildResetUrl(rawUrl, process.env.PASSWORD_RESET_REDIRECT_URL?.trim());

    await sendAccountSetupEmail({ to: email, setupUrl });
    return { sent: true };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { subsystem: 'account-setup-invite' },
      extra: { userId, email },
    });
    return { sent: false, error: errorMessage(error) };
  }
}
