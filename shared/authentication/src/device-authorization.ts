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
  selectMemberRole: (userId: string) => Promise<{ role: string } | undefined>
): Promise<void> {
  const row = await selectMemberRole(userId);
  if (!row || row.role === 'member' || !(row.role in WXYCRoles)) {
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
  updateSessionExpiry: (token: string, expiresAt: Date) => Promise<void>
): Promise<void> {
  const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS);
  await updateSessionExpiry(sessionToken, expiresAt);
  responseBody.expires_in = DEVICE_SESSION_TTL_MS / 1000;
}
