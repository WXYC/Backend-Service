import { APIError } from 'better-auth/api';

/**
 * The better-auth admin plugin routes that write `auth_user.role`.
 *
 * All three land in `parseRoles` (`plugins/admin/routes.mjs:21`), which is
 * where the multi-role join happens. `/admin/create-user` is the one most
 * easily overlooked and is how the legacy station-role values in the column
 * were written in the first place.
 */
export const GUARDED_ROLE_WRITE_PATHS = ['/admin/set-role', '/admin/update-user', '/admin/create-user'] as const;

/**
 * Reject any `role` write that would not persist as a single scalar value.
 *
 * The admin plugin validates role inputs *element-wise* and only then joins
 * them: `/admin/set-role` (`routes.mjs:70-76`), `/admin/update-user`
 * (`:265-271`) and `/admin/create-user` (`:173-177`) each loop
 * `for (const role of inputRoles) if (!roles[role]) throw`, then write
 * `parseRoles(ctx.body.role)` — `Array.isArray(roles) ? roles.join(",") : roles`.
 *
 * So `{"role": ["admin", "user"]}` passes the plugin's own allowlist twice
 * over — both keys exist — and persists the string `"admin,user"`. That is
 * the ambiguity `auth_user.role` is being narrowed to remove, and it would
 * reach the column's CHECK constraint as an unhandled 23514, i.e. a 500.
 * Rejecting at the request boundary keeps it a 400.
 *
 * This guard owns exactly one property — that whatever reaches `parseRoles`
 * cannot become a comma list. It deliberately does *not* re-validate which
 * scalar values are allowed; the plugin's pinned `roles` option owns that,
 * and duplicating the alphabet here would drift from it on upgrade.
 *
 * Exported as a pure function so the policy is unit-testable without
 * standing up better-auth, matching `applyDeviceApproveRoleGate`.
 */
export function assertScalarRoleWrite(path: string, body: { role?: unknown } | null | undefined): void {
  if (!(GUARDED_ROLE_WRITE_PATHS as readonly string[]).includes(path)) return;

  const role = body?.role;
  // Omitting `role` is legitimate on create-user and update-user: the
  // plugin's `user.create.before` hook stamps the configured defaultRole.
  if (role === undefined || role === null) return;

  const offending =
    Array.isArray(role) ||
    typeof role !== 'string' ||
    // A comma in a scalar string is indistinguishable from a joined list by
    // the time it reaches the column, so it is refused at the same door.
    role.includes(',');

  if (offending) {
    throw new APIError('BAD_REQUEST', {
      code: 'ROLE_MUST_BE_SCALAR',
      message:
        `\`role\` must be a single value without commas on ${path}. ` +
        'Multi-role values are persisted comma-joined, which this service does not support.',
    });
  }
}
