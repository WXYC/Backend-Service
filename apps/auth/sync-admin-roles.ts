/**
 * Startup reconciliation of `auth_user.role` — the better-auth admin plugin's
 * system flag — against organization membership.
 *
 * The per-event hooks in `admin-flag-sync.ts` keep the flag current as
 * membership changes; this closes the gap they cannot, since a hook that
 * failed (a DB blip, a process killed mid-write) leaves the flag stale with
 * nothing to retry it. Running on every boot means the flag converges without
 * operator intervention.
 *
 * Extracted from `apps/auth/app.ts`, where it was a module-local `const`
 * reachable only after a top-level IIFE calls `app.listen()` — importing the
 * module to test it would start a server. DB access arrives as callbacks so
 * the reconciliation policy can be exercised directly.
 */

/** A user whose membership justifies the admin flag but whose flag disagrees. */
export interface AdminFlagMismatch {
  userId: string;
  userEmail: string;
  userRole: string | null;
  memberRole: string;
}

export interface SyncAdminRolesDeps {
  defaultOrgSlug: string | undefined;
  /** Users in the default org holding an admin-granting role without the flag. */
  findUsersMissingAdminFlag: (defaultOrgSlug: string) => Promise<AdminFlagMismatch[]>;
  setUserRole: (userId: string, role: 'admin' | null) => Promise<void>;
}

/**
 * Grant the admin flag to every default-org member whose role justifies it
 * but who lacks it.
 *
 * Throws on failure. The caller already needs a catch for its own module
 * resolution, and a second one here would route both failures to the same
 * handler by a longer path; warn-and-continue is the caller's contract, not
 * this function's. Stopping partway through the loop is safe either way — the
 * next boot re-reads the mismatches and resumes.
 */
export const syncAdminRoles = async (deps: SyncAdminRolesDeps): Promise<void> => {
  const { defaultOrgSlug } = deps;
  if (!defaultOrgSlug) {
    console.log('[ADMIN PERMISSIONS] DEFAULT_ORG_SLUG not set, skipping admin role fix');
    return;
  }

  const usersNeedingFix = await deps.findUsersMissingAdminFlag(defaultOrgSlug);

  if (usersNeedingFix.length > 0) {
    console.log(`[ADMIN PERMISSIONS] Found ${usersNeedingFix.length} users needing admin role fix: `);
    for (const u of usersNeedingFix) {
      console.log(`[ADMIN PERMISSIONS] - ${u.userEmail} (${u.memberRole}) - current role: ${u.userRole || 'null'}`);
      await deps.setUserRole(u.userId, 'admin');
      console.log(`[ADMIN PERMISSIONS] - Fixed: ${u.userEmail} now has admin role`);
    }
  } else {
    console.log('[ADMIN PERMISSIONS] All stationManagers already have admin role');
  }
};
