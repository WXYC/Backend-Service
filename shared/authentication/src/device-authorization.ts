import { APIError } from 'better-auth/api';
import { WXYCRoles } from './auth.roles';

// QR device-authorization session TTL (ADR 0008). Browser sessions created
// via /device/token live for 12h, long enough to cover a longest-possible
// double DJ shift but bounded so a forgotten control-room login doesn't
// linger indefinitely. The plugin's createSession call uses the global
// session.expiresIn default; the auth.definition.ts after-hook clamps
// device-auth sessions to this constant without affecting password sign-in.
export const DEVICE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Reject non-DJ users at /device/approve. Exported so the unit test can
 * exercise the policy without standing up the better-auth middleware.
 *
 * The plugin's own /device/approve route requires a session and flips the
 * device-code row to `approved` on success. We run before that flip so a
 * `member` (or a user with no membership / a role outside WXYCRoles) never
 * lands an approved row in the DB. Throwing `access_denied` is fine: the
 * error code is already part of the plugin's /device/token enum, so the
 * polling browser sees a clean RFC 8628 `access_denied` response on its
 * next poll.
 */
export async function applyDeviceApproveRoleGate(
  userId: string,
  selectMemberRole: (userId: string) => Promise<{ role: string } | undefined>,
  clearClaimant: (userId: string) => Promise<void>
): Promise<void> {
  const row = await selectMemberRole(userId);
  if (!row || row.role === 'member' || !Object.hasOwn(WXYCRoles, row.role)) {
    // S1: reset the claim so a legitimate DJ can still approve the same
    // user_code before it TTLs — the plugin's /device/approve requires
    // `deviceCodeRecord.userId === session.user.id`, so leaving the
    // rejected user's id on the row would burn the code for its 5-min
    // window. clearClaimant is scoped by userId so we only touch the
    // caller's own claim, not somebody else's in-flight approve.
    await clearClaimant(userId);
    throw new APIError('FORBIDDEN', {
      error: 'access_denied',
      error_description: 'Sign-in requires the DJ role or above.',
    });
  }
}

/**
 * Clamp the just-created device-auth session to DEVICE_SESSION_TTL_MS.
 * Exported so the unit test can exercise the math without standing up the
 * better-auth middleware. The plugin's /device/token route calls
 * `internalAdapter.createSession(user.id)` with the global session.expiresIn
 * default (7 days for cookie sessions) and returns `{ access_token,
 * token_type, expires_in, scope }`. We update the persisted row's
 * `expiresAt` and mutate the response body's `expires_in` so the browser
 * and the DB agree.
 */
export async function applyDeviceTokenSessionTtl(
  sessionToken: string,
  responseBody: { expires_in?: number; [k: string]: unknown },
  now: Date,
  updateSessionExpiry: (token: string, expiresAt: Date, deviceFlowExpiresAt: Date) => Promise<void>
): Promise<void> {
  const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS);
  // deviceFlowExpiresAt is the hard cap the update-hook enforces. We write
  // both fields on the same UPDATE so the row is consistent from the
  // moment /device/token returns.
  await updateSessionExpiry(sessionToken, expiresAt, expiresAt);
  responseBody.expires_in = DEVICE_SESSION_TTL_MS / 1000;
}

/**
 * Enforce the 12h ceiling against better-auth's rolling session refresh.
 *
 * Every `getSession` call whose row is past `updateAge` (default 1 day)
 * fires `internalAdapter.updateSession(token, { expiresAt: now + 7d, ...})`
 * — the default session `expiresIn` is 7 days and the refresh math at
 * `node_modules/better-auth/dist/api/routes/session.mjs:205` re-uses that
 * ceiling on every refresh. For a session we clamped to 12h at mint time,
 * `(mint + 12h) - 7d + 1d ≤ now` evaluates to true immediately, so the
 * very first call would walk `expires_at` back out to 7 days and the
 * "self-cleans before the next morning" property of ADR 0008 collapses.
 *
 * Exposed for the unit test. The auth.definition.ts
 * `databaseHooks.session.update.before` invocation feeds this the incoming
 * update payload and the row's current `device_flow_expires_at`; if the
 * row is device-flow-marked and the incoming payload wants to bump
 * `expiresAt` past that cap, we override the payload so the update writes
 * at most the cap. Non-device sessions (cap === null) are untouched.
 */
export function capSessionUpdateAgainstDeviceFlow(
  data: { expiresAt?: Date | string | null } & Record<string, unknown>,
  currentCap: Date | null | undefined
): { data: { expiresAt: Date } } | undefined {
  if (!currentCap || !data.expiresAt) return undefined;
  const incoming = data.expiresAt instanceof Date ? data.expiresAt : new Date(data.expiresAt);
  if (Number.isNaN(incoming.getTime())) return undefined;
  if (incoming.getTime() <= currentCap.getTime()) return undefined;
  return { data: { expiresAt: currentCap } };
}
