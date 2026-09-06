/**
 * Station signup: `POST /auth/wxyc/station-signup` (BS#2361).
 *
 * The public endpoint a DJ walks up to and uses: passcode-gated self-signup
 * that provisions a `dj`-role account. Three decisions repeated here because
 * a careless "harmonize the endpoints" edit would silently reverse them:
 *
 * - This endpoint accepts a caller-chosen password where
 *   `/auth/admin/provision-user` refuses one. That endpoint refuses because
 *   an admin must not choose ANOTHER user's password; here the account
 *   holder is choosing their own, so the same objection does not apply.
 *   Reusing the invite flow instead would mint a random bootstrap password
 *   and force the DJ to open email and click a setup link before they could
 *   log a show — defeating the entire premise of walking in and signing up.
 *
 * - ORDERING, which is the whole security argument for this file. The
 *   handler runs, strictly in this order: (0) the two pure env preconditions
 *   (feature flag, `DEFAULT_ORG_SLUG`); (1) every shape check; (2) the
 *   passcode MATCH; (3) the email/username existence checks and the org
 *   row's; (4) the
 *   passcode CLAIM; (5) `provisionUser`. Two properties fall out, and the
 *   endpoint owes both at once:
 *
 *     * NOTHING an unauthenticated caller can vary changes the response
 *       until they have proven they hold a live code. A garbage passcode
 *       gets the same generic 401 whether the submitted email is already
 *       registered or not, and the attempt is logged either way. The first
 *       revision of this file ran the existence check FIRST, which made the
 *       endpoint an unauthenticated email-registration oracle: 409
 *       `EMAIL_TAKEN` (with the address echoed back) versus 401, decided
 *       before the passcode was ever looked at, writing no
 *       `station_signup_attempt` row — so it was invisible to the cooldown
 *       and to #2362's status endpoint and #2364's digest alike, bounded
 *       only by the 60s/120 limiter.
 *     * A fumbled username or a duplicate email still claims NOTHING. Step
 *       (2) does not touch `use_count`; only step (4) does. Validating
 *       inside `provisionUser` instead would let an ordinary typo burn one
 *       of a code's limited uses on every retry, and 25 fumbles would revoke
 *       the code out from under an entire room of DJs.
 *
 *   A single fused `verifyStationPasscode` cannot deliver both — matching
 *   and claiming in one call forces the existence checks either wholly
 *   before it (the oracle) or wholly after it (the burned uses). That is why
 *   station-passcode.ts exposes `matchStationPasscode` and
 *   `claimStationPasscode` separately; see their doc comments, and the
 *   attempt-log invariant on the first of them.
 *
 *   ACCEPTED RESIDUAL: a code can reach its cap, be revoked, or expire in
 *   the window between the match and the claim. The claim's own conditional
 *   UPDATE catches that, the request gets the same generic 401 as any other
 *   refusal, and no use is burned. That race already existed inside the
 *   fused call; splitting the phases only widens it by two indexed reads.
 *
 * - USERNAME CASE. better-auth's `username` plugin lowercases on store and
 *   duplicate-checks the LOWERCASED value, so this handler normalizes once,
 *   at the top, and uses the normalized value everywhere after: validation,
 *   the existence lookup, `provisionUser`, and the response. Querying the
 *   raw value let `NewDJ` sail past a pre-check against a stored `newdj`,
 *   claim a use, and then die inside the plugin's own create hook with
 *   "Username is already taken. Please try another." — a message
 *   `provisionUser`'s duplicate heuristic did not match, so it surfaced as a
 *   500 with the use already burned.
 *
 * The response stays generic on an invalid passcode: never distinguish
 * wrong from expired from revoked from exhausted (that classification lives
 * only in the attempt log the match/claim phases write). No session is
 * minted — the DJ signs in normally with the password they just chose,
 * keeping session creation on the one path that owns it.
 */

import {
  auth,
  claimStationPasscode,
  formatUsernameError,
  matchStationPasscode,
  validateUsername,
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

// better-auth's own `maxPasswordLength` default (create-context.mjs:
// `options.emailAndPassword?.maxPasswordLength || 128`), which
// auth.definition.ts does not override. The ceiling has to be enforced HERE
// rather than left to `provisionUser`: that function hashes the password
// itself and never length-checks it, so without this an over-length password
// would be accepted at signup and then rejected by every better-auth path
// that does check (sign-up, update-user, reset-password) — an account whose
// own password is unusable through the flows that own it. Enforcing the same
// number keeps this endpoint inside better-auth's contract instead of
// beside it.
const MAX_PASSWORD_LENGTH = 128;

// `auth_user.email`, `.real_name` and `.dj_name` are all `varchar(255)`
// (shared/database/src/schema.ts). Checked before the passcode is matched,
// so an over-length value can never reach `provisionUser` after a use has
// been claimed and blow up on the column constraint with the use burned.
// `username` keeps its own 30-character cap, enforced by `validateUsername`
// (the better-auth username plugin's `maxUsernameLength`).
const MAX_EMAIL_LENGTH = 255;
const MAX_REAL_NAME_LENGTH = 255;
const MAX_DJ_NAME_LENGTH = 255;

// Generously above any real code's length (the sticky note holds a short
// string) while keeping the bound in THIS file's shape phase rather than in
// express.json()'s 100 kB body default. The match hashes both sides before
// comparing, so an over-length value costs hashing work, never a timing or
// length oracle — this cap is symmetry with the four fields above, not a
// security control.
const MAX_PASSCODE_LENGTH = 128;

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

function requireMaxLength(value: string, max: number, field: string): string {
  if (value.length > max) {
    throw new StationSignupError(400, `${field} must be at most ${max} characters`, 'INVALID_REQUEST');
  }
  return value;
}

/**
 * Existence pre-check for BOTH email and username. Runs BEHIND the passcode
 * match and AHEAD of the claim (see the module docblock's ORDERING note), so
 * duplicate-email/-username is observable only to a caller who has already
 * proven they hold a live passcode — the enumeration oracle the issue body
 * accepts by name, on the same footing as `/auth/wxyc/lookup-email`, which
 * exposes a comparable signal to the open internet by design.
 *
 * `username` must be the NORMALIZED (lowercased) value: better-auth stores
 * and duplicate-checks the lowercased form, so a raw-case lookup here would
 * miss an existing row and hand the mismatch to `provisionUser` after a use
 * was claimed.
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
 * Step (0) checks that `DEFAULT_ORG_SLUG` is SET; whether it names a real
 * `organization` row is only discoverable in the database. Discovering it
 * inside `provisionUser` — after the claim — burns one use per attempt on a
 * host whose slug is wrong (typo, un-seeded org, renamed slug): 25 requests
 * brick the sticky-note code, the lockout epic #2365 forbids outright. One
 * indexed read here keeps that failure loud and free — a generic 500 with no
 * use claimed. Post-gate and driven by config alone, it varies with nothing
 * in the request, so it leaks nothing.
 */
async function assertOrganizationExists(organizationSlug: string): Promise<void> {
  const context = await auth.$context;
  const org = await context.adapter.findOne<{ id: string }>({
    model: 'organization',
    where: [{ field: 'slug', value: organizationSlug }],
  });
  if (!org) {
    throw new Error(
      `DEFAULT_ORG_SLUG "${organizationSlug}" names no organization; cannot provision a station-signup account`
    );
  }
}

/**
 * Translate a `ProvisionError` into something safe to hand an
 * unauthenticated caller.
 *
 * Never forward `error.message` verbatim. `provisionUser` composes its
 * messages out of server-side configuration — most sharply
 * `Organization not found for slug: "<DEFAULT_ORG_SLUG>"`, which would leak
 * the org slug of a misconfigured deployment to anyone holding a passcode —
 * and the rest name internals a signup form has no use for. The real message
 * goes to the log; the caller gets the curated one.
 */
function clientSafeProvisionFailure(error: ProvisionError): StationSignupError {
  console.error('[STATION SIGNUP] provisionUser failed:', error.statusCode, error.message);
  switch (error.statusCode) {
    case 409:
      // Lost a race against a concurrent signup between the existence check
      // above and `createUser` — the only 409 reachable from here.
      return new StationSignupError(409, 'That email address or username is already registered', 'ALREADY_REGISTERED');
    case 400:
      // Shape rejected inside provisionUser despite this endpoint's own
      // validation (role, username). Not reachable today; kept curated
      // rather than echoed in case a future validator there diverges.
      return new StationSignupError(400, 'Invalid signup details', 'INVALID_REQUEST');
    default:
      // 404 (missing organization) and anything else: server-side
      // misconfiguration, not something the caller can fix or should see.
      return new StationSignupError(500, 'Signup is temporarily unavailable', 'PROVISION_FAILED');
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
    // Defence in depth. app.ts does not MOUNT this route when the flag is
    // off, so a disabled deployment answers with better-auth's own
    // catch-all and is indistinguishable from one that never shipped the
    // feature. This guard covers direct callers (and the unit test) and
    // keeps the 404 shape if the route is ever mounted unconditionally
    // again.
    throw new StationSignupError(404, 'Not found', 'NOT_FOUND');
  }

  // Hoisted ABOVE every DB read and the passcode itself, because it is a
  // pure env read with nothing to learn from the request. Checked after the
  // claim (the shipped order), a deploy with DEFAULT_ORG_SLUG unset would
  // burn one use per attempt and brick the code inside 25 requests — the
  // control-room lockout epic #2365 forbids outright — while every caller
  // got a 500 anyway. Fail loudly rather than provision into a missing org;
  // mirrors create-auto-dj-user.ts's guard. This covers the variable being
  // SET; whether it names a real row is checked at step (3), still ahead of
  // the claim — see assertOrganizationExists.
  const organizationSlug = process.env.DEFAULT_ORG_SLUG;
  if (!organizationSlug) {
    throw new Error('DEFAULT_ORG_SLUG is not set; cannot provision a station-signup account');
  }

  // ---- (1) Shape. All of it, before the passcode is touched. ----
  const passcode = requireMaxLength(requireNonEmptyString(body.passcode, 'passcode'), MAX_PASSCODE_LENGTH, 'passcode');
  const rawUsername = requireNonEmptyString(body.username, 'username');
  const email = requireMaxLength(requireNonEmptyString(body.email, 'email'), MAX_EMAIL_LENGTH, 'email');
  const password = requireNonEmptyString(body.password, 'password');
  const realName = requireMaxLength(requireNonEmptyString(body.realName, 'realName'), MAX_REAL_NAME_LENGTH, 'realName');
  const djName =
    typeof body.djName === 'string' && body.djName.length > 0
      ? requireMaxLength(body.djName, MAX_DJ_NAME_LENGTH, 'djName')
      : undefined;

  // Normalize ONCE, here, and never read `rawUsername` again — see the
  // USERNAME CASE note in the module docblock.
  const username = rawUsername.toLowerCase();

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
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new StationSignupError(
      400,
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      'PASSWORD_TOO_LONG'
    );
  }

  // ---- (2) The gate. Cooldown, decrypt, compare — no use claimed. ----
  // Every refusal below is byte-identical regardless of anything else in the
  // request: this is the point past which the caller has proven they hold a
  // live code, and nothing before it may vary with the email or username.
  const matched = await matchStationPasscode(passcode, { rawClientIp });
  if (!matched.ok || !matched.passcodeId) {
    if (matched.cooldown) {
      const minutes = Math.ceil(SIGNUP_COOLDOWN_HOLD_MS / 60_000);
      throw new StationSignupError(
        429,
        `Signups are temporarily unavailable. Try again in about ${minutes} minutes.`,
        'COOLDOWN'
      );
    }
    throw new StationSignupError(401, 'Invalid or expired signup code', 'INVALID_PASSCODE');
  }

  // ---- (3) Existence checks. Behind the gate, ahead of the claim. ----
  await assertEmailAndUsernameAvailable(email, username);

  // Last check before anything is consumed: the org row the provision step
  // will resolve. See assertOrganizationExists for why this cannot wait
  // until after the claim.
  await assertOrganizationExists(organizationSlug);

  // ---- (4) Claim exactly one use. ----
  const claim = await claimStationPasscode(matched.passcodeId, { rawClientIp });
  if (!claim.ok) {
    // The code was correct but reached its cap, was revoked, or expired
    // since step (2). Same generic refusal as any other invalid code — the
    // caller learns nothing, and retries.
    throw new StationSignupError(401, 'Invalid or expired signup code', 'INVALID_PASSCODE');
  }

  // ---- (5) Provision. Role is a SERVER-SIDE CONSTANT — never read from
  // the request body. member/musicDirector/stationManager must be
  // unreachable through this path; `member` alone cannot do the thing the
  // DJ walked in to do.
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
      throw clientSafeProvisionFailure(error);
    }
    throw error;
  }

  await sendAddressVerificationProbe(provisioned.user.email);

  // Echo the stored row, not the request: better-auth's username plugin
  // normalizes on write, so the created row is the only authority on what
  // this account's username actually is. `email` already came back this way.
  const storedUsername = typeof provisioned.user.username === 'string' ? provisioned.user.username : username;

  // No session minted here — the DJ signs in normally with the password
  // they just chose.
  return {
    status: true,
    userId: provisioned.user.id,
    email: provisioned.user.email,
    username: storedUsername,
  };
}
