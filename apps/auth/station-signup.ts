/**
 * Station signup: `POST /auth/wxyc/station-signup` (BS#2361).
 *
 * The public endpoint a DJ walks up to and uses: passcode-gated self-signup
 * that provisions a `dj`-role account. Two decisions repeated here because a
 * careless "harmonize the endpoints" edit would silently reverse them:
 *
 * - This endpoint accepts a caller-chosen password where
 *   `/auth/admin/provision-user` refuses one. That endpoint refuses because
 *   an admin must not choose ANOTHER user's password; here the account
 *   holder is choosing their own, so the same objection does not apply.
 *   Reusing the invite flow instead would mint a random bootstrap password
 *   and force the DJ to open email and click a setup link before they could
 *   log a show — defeating the entire premise of walking in and signing up.
 * - Every input unrelated to the passcode itself (username, email, password
 *   shape, and whether the email/username already exist) is validated
 *   BEFORE `verifyStationPasscode` is ever called. That call claims a use on
 *   a genuine match; validating only inside `provisionUser` would let an
 *   ordinary typo burn one of a code's limited uses on every retry, and 25
 *   fumbles would revoke the code out from under an entire room of DJs. See
 *   `verifyStationPasscode`'s own doc comment, which names this file.
 *
 * The response stays generic on an invalid passcode: never distinguish
 * wrong from expired from revoked from exhausted (that classification lives
 * only in the attempt log `verifyStationPasscode` writes). No session is
 * minted — the DJ signs in normally with the password they just chose,
 * keeping session creation on the one path that owns it.
 */

import {
  auth,
  formatUsernameError,
  validateUsername,
  verifyStationPasscode,
  sendVerificationEmailMessage,
  SIGNUP_COOLDOWN_HOLD_MS,
} from '@wxyc/authentication';
import { isValidEmail } from '@wxyc/shared/validation';
import { provisionUser, ProvisionError } from './provision-user';

export class StationSignupError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'StationSignupError';
  }
}

// Mirrors auth.definition.ts's `minPasswordLength: 8` — better-auth's own
// sign-in/reset paths enforce that floor, so an account this endpoint
// provisions below it could be created but never re-authenticate cleanly
// through the ordinary password-reset flow's own validation.
const MIN_PASSWORD_LENGTH = 8;

/** Strict `=== 'true'` gate, same convention as DONATE_ENABLED / FLOWSHEET_TAKEOVER_ENABLED. Ships OFF. */
export function isStationSignupEnabled(): boolean {
  return process.env.STATION_SIGNUP_ENABLED === 'true';
}

export interface StationSignupResult {
  status: true;
  userId: string;
  email: string;
  username: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StationSignupError(400, `${field} is required`, 'INVALID_REQUEST');
  }
  return value;
}

/**
 * Existence pre-check for BOTH email and username, ahead of the passcode
 * claim. Deliberately makes duplicate-email/-username observable to anyone
 * holding a valid passcode — an enumeration oracle accepted per the issue
 * body: it sits behind the passcode gate, and `/auth/wxyc/lookup-email`
 * already exposes a comparable signal to the open internet by design.
 */
async function assertEmailAndUsernameAvailable(email: string, username: string): Promise<void> {
  const context = await auth.$context;

  const existingByEmail = await context.internalAdapter.findUserByEmail(email);
  if (existingByEmail) {
    throw new StationSignupError(409, `An account with email "${email}" already exists`, 'EMAIL_TAKEN');
  }

  // Same lookup shape as lookup-email.ts's identifier resolver.
  const existingByUsername = await context.adapter.findOne<{ id: string }>({
    model: 'user',
    where: [{ field: 'username', value: username }],
  });
  if (existingByUsername) {
    throw new StationSignupError(409, `Username "${username}" is already taken`, 'USERNAME_TAKEN');
  }
}

/**
 * Send the post-signup address-verification email. Be precise about what
 * this buys: `provisionUser` sets `emailVerified: true` unconditionally, so
 * clicking the link changes no state and password reset works regardless.
 * It is a DELIVERABILITY PROBE — a bounce is the cheap signal the DJ
 * mistyped their address, ahead of the manager review that is the real
 * check. Assert the send, never a verification-state change. Best effort:
 * a failed send must never undo an already-provisioned account.
 */
async function sendAddressVerificationProbe(email: string): Promise<void> {
  const frontendUrl = process.env.FRONTEND_SOURCE || 'http://localhost:3000';
  try {
    // There is nothing left to verify (see above), so the link lands on
    // sign-in rather than a real /verify-email callback.
    await sendVerificationEmailMessage({ to: email, verificationUrl: `${frontendUrl}/login` });
  } catch (error) {
    console.error('[STATION SIGNUP] Failed to send address-verification probe email:', error);
  }
}

export async function stationSignupFromRequest(
  body: Record<string, unknown>,
  rawClientIp: string | undefined
): Promise<StationSignupResult> {
  if (!isStationSignupEnabled()) {
    // 404, not 403: outside the holiday windows this exists for, the
    // endpoint should look like it doesn't exist.
    throw new StationSignupError(404, 'Not found', 'NOT_FOUND');
  }

  // Validate the WHOLE request before the passcode is ever touched. See the
  // module docblock and verifyStationPasscode's own comment: the use-claim
  // it performs internally must never fire for a request about to be
  // rejected for an unrelated reason.
  const passcode = requireNonEmptyString(body.passcode, 'passcode');
  const username = requireNonEmptyString(body.username, 'username');
  const email = requireNonEmptyString(body.email, 'email');
  const password = requireNonEmptyString(body.password, 'password');
  const realName = requireNonEmptyString(body.realName, 'realName');
  const djName = typeof body.djName === 'string' && body.djName.length > 0 ? body.djName : undefined;

  const usernameError = validateUsername(username);
  if (usernameError) {
    throw new StationSignupError(400, formatUsernameError(usernameError), 'INVALID_USERNAME');
  }
  if (!isValidEmail(email)) {
    throw new StationSignupError(400, 'Invalid email address', 'INVALID_EMAIL');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new StationSignupError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 'WEAK_PASSWORD');
  }

  await assertEmailAndUsernameAvailable(email, username);

  // Cooldown check, decrypt/compare against every active row, and the
  // atomic use-claim on a genuine match all happen inside this one call —
  // see station-passcode.ts. Stay generic either way.
  const verification = await verifyStationPasscode(passcode, { rawClientIp });
  if (!verification.ok) {
    if (verification.cooldown) {
      const minutes = Math.ceil(SIGNUP_COOLDOWN_HOLD_MS / 60_000);
      throw new StationSignupError(
        429,
        `Signups are temporarily unavailable. Try again in about ${minutes} minutes.`,
        'COOLDOWN'
      );
    }
    throw new StationSignupError(401, 'Invalid or expired signup code', 'INVALID_PASSCODE');
  }

  // Role is a SERVER-SIDE CONSTANT — never read from the request body.
  // member/musicDirector/stationManager must be unreachable through this
  // path; `member` alone cannot do the thing the DJ walked in to do.
  const organizationSlug = process.env.DEFAULT_ORG_SLUG;
  if (!organizationSlug) {
    // Fail loudly rather than provision into a missing org — mirrors
    // create-auto-dj-user.ts's DEFAULT_ORG_SLUG guard. The passcode use is
    // already claimed at this point; that is the safe direction to err once
    // validation has passed (issue body).
    throw new Error('DEFAULT_ORG_SLUG is not set; cannot provision a station-signup account');
  }

  let provisioned;
  try {
    provisioned = await provisionUser({
      email,
      username,
      password,
      organizationSlug,
      role: 'dj',
      realName,
      djName,
      sendSetupInvite: false,
      hasCompletedOnboarding: true,
      selfSignupAt: new Date(),
    });
  } catch (error) {
    if (error instanceof ProvisionError) {
      throw new StationSignupError(error.statusCode, error.message);
    }
    throw error;
  }

  await sendAddressVerificationProbe(email);

  // No session minted here — the DJ signs in normally with the password
  // they just chose.
  return {
    status: true,
    userId: provisioned.user.id,
    email: provisioned.user.email,
    username,
  };
}
