/**
 * Account-setup invite token TTL.
 *
 * Admin-provisioned DJs receive an "account setup" email whose link carries a
 * better-auth `reset-password:<token>` verification token. A genuine password
 * reset is acted on within minutes, so better-auth defaults that token to 1
 * hour. An onboarding invite is different: DJs open the setup email hours-to-
 * days after an admin provisions them, so a 1-hour window locked new DJs out
 * (BS#1969). The account-setup path therefore mints/extends its token with this
 * much longer TTL, while genuine password resets keep the 1-hour default.
 *
 * Kept in its own leaf module (no `auth`/better-auth imports) so both the
 * `sendResetPassword` hook in `auth.definition.ts` and the
 * `createAndSendAccountSetupInvite` helper can read it without an import cycle.
 */

/** Default account-setup token TTL: 7 days, in seconds. */
export const ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS = 60 * 60 * 24 * 7;

/**
 * Resolve the account-setup invite token TTL (seconds) from
 * `ACCOUNT_SETUP_TOKEN_EXPIRES_IN`, falling back to the 7-day default when the
 * var is unset, non-numeric, or non-positive.
 */
export const accountSetupTokenExpiresInSeconds = (): number => {
  const raw = process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN;
  if (raw === undefined) return ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS;
};
