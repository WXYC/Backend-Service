/**
 * Revoke a user's outstanding account-setup invite tokens.
 *
 * better-auth's `POST /reset-password` consumes only the token it is handed
 * (`consumeVerificationValue`) — it never sweeps the user's other outstanding
 * `reset-password:` rows, and it checks neither ban state nor onboarding state.
 * So before this, every roster "Send Invite" resend left the previous link
 * alive for its full TTL, and a token that outlived onboarding stayed a working
 * password-reset for a by-then ACTIVE DJ account. Each invite therefore has to
 * revoke its predecessors explicitly.
 *
 * The invariant this maintains: a user has at most ONE live account-setup token
 * at a time, and none once they have onboarded.
 *
 * Scope note — the `reset-password:` identifier space is shared between genuine
 * password resets and account-setup invites (deliberately, so the downstream
 * GET redirect and `complete-onboarding` consumption stay on better-auth's
 * supported surface). That is why this is only ever called on account-setup
 * paths, where the user has NOT completed onboarding: for such a user every
 * `reset-password:` row is a setup token, including one minted by a public
 * forgot-password, which the `sendResetPassword` hook also treats as a setup
 * invite. A completed user's genuine reset tokens are never in range.
 *
 * Kept in its own leaf module (no `auth`/better-auth imports) so both the
 * `sendResetPassword` hook in `auth.definition.ts` and the
 * `createAndSendAccountSetupInvite` helper can call it without an import cycle,
 * mirroring `account-setup-token.ts`.
 */

import * as Sentry from '@sentry/node';
import { db, verification } from '@wxyc/database';
import { and, eq, like, lt, ne } from 'drizzle-orm';

/** better-auth's verification identifier prefix for password-reset/setup tokens. */
export const ACCOUNT_SETUP_TOKEN_PREFIX = 'reset-password:';

export interface RevokeAccountSetupTokensOptions {
  /**
   * Identifier to spare, i.e. `reset-password:<token>` of the invite being sent
   * right now. Omit to revoke every outstanding token — the correct call once
   * onboarding is complete.
   */
  exceptIdentifier?: string;
  /**
   * Upper bound on `created_at`: only rows older than this are revoked. Pass the
   * instant the caller's own token was minted.
   *
   * Without it, two admins clicking "Send Invite" at the same moment each revoke
   * the other's brand-new token and the DJ is left with two dead links. Bounding
   * the delete to strictly-older rows makes the newest invite win under either
   * interleaving. Safe to compare against an app clock: better-auth stamps
   * `createdAt` with `new Date()` in-process (`internal-adapter.mjs`), not with a
   * database default, so this is the same clock that wrote the rows.
   *
   * Omit once onboarding is complete, where every surviving token should go.
   */
  createdBefore?: Date;
}

/**
 * Delete the user's outstanding account-setup tokens and return how many rows
 * were revoked.
 *
 * Never throws. Revocation is a hardening step layered onto paths that must
 * still succeed for the DJ — a failure here leaves a stale token alive (the
 * pre-existing behavior) but must not cost the user their new invite or block
 * onboarding completion, so failures are captured to Sentry and swallowed.
 */
export async function revokeOutstandingAccountSetupTokens(
  userId: string,
  options: RevokeAccountSetupTokensOptions = {}
): Promise<number> {
  const { exceptIdentifier, createdBefore } = options;

  const predicates = [eq(verification.value, userId), like(verification.identifier, `${ACCOUNT_SETUP_TOKEN_PREFIX}%`)];
  if (exceptIdentifier) predicates.push(ne(verification.identifier, exceptIdentifier));
  if (createdBefore) predicates.push(lt(verification.createdAt, createdBefore));

  try {
    const revoked = await db
      .delete(verification)
      .where(and(...predicates))
      .returning({ id: verification.id });
    return revoked.length;
  } catch (error) {
    console.error('Error revoking outstanding account-setup tokens:', error);
    Sentry.captureException(error, {
      tags: { subsystem: 'account-setup-invite', step: 'revoke-outstanding-tokens' },
      extra: { userId },
    });
    return 0;
  }
}
