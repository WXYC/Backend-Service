/**
 * Keep `auth_user.role` — the better-auth admin plugin's system flag — in
 * step with organization membership in the default organization.
 *
 * The flag is a *derived* value: it says only whether the user may use the
 * admin plugin's own routes, and is recomputed here whenever the membership
 * that justifies it changes. The station role itself lives in
 * `auth_member.role` and is never read from here (BS#2171).
 *
 * Extracted from the `organizationHooks` literal in `auth.definition.ts` so
 * the policy is unit-testable; the three hooks shared a near-identical
 * prologue, so the extraction removes real duplication rather than only
 * serving the tests. DB access arrives as callbacks — a value import from
 * `@wxyc/database` would re-engage the mock at `jest.unit.config.ts` and
 * defeat the injection.
 */

/**
 * Membership roles that justify the admin flag.
 *
 * `stationManager` is the WXYC station role; `admin` and `owner` are
 * better-auth's own organization roles, which a member row can also carry.
 */
export const ADMIN_GRANTING_MEMBER_ROLES: readonly string[] = ['stationManager', 'admin', 'owner'];

export const grantsAdminFlag = (memberRole: string): boolean => ADMIN_GRANTING_MEMBER_ROLES.includes(memberRole);

export interface AdminFlagSyncDeps {
  /**
   * Read per invocation rather than at module load: the hooks read
   * `process.env.DEFAULT_ORG_SLUG` on every fire, and a process that boots
   * before the variable is set must start syncing once it appears.
   */
  defaultOrgSlug: string | undefined;
  setUserRole: (userId: string, role: 'admin' | null) => Promise<void>;
  onError: (error: unknown) => void;
}

type MemberIdentity = { id: string; email: string };

/**
 * Shared prologue: the sync applies only to the default organization, and
 * only when that organization is configured at all.
 */
const appliesToDefaultOrganization = (organizationSlug: string, defaultOrgSlug: string | undefined): boolean => {
  if (!defaultOrgSlug) {
    console.warn('DEFAULT_ORG_SLUG is not set, skipping admin role sync');
    return false;
  }
  return organizationSlug === defaultOrgSlug;
};

/** Grant the admin flag when a member joins the default org in an admin-granting role. */
export async function syncAdminFlagOnAddMember(
  args: { member: { role: string }; user: MemberIdentity; organization: { slug: string } },
  deps: AdminFlagSyncDeps
): Promise<void> {
  try {
    if (!appliesToDefaultOrganization(args.organization.slug, deps.defaultOrgSlug)) return;

    if (grantsAdminFlag(args.member.role)) {
      const userId = args.user.id;
      await deps.setUserRole(userId, 'admin');
      console.log(
        `Granted admin role to user ${userId} (${args.user.email}) with ${args.member.role} role in default organization`
      );
    }
  } catch (error) {
    deps.onError(error);
  }
}

/**
 * Grant or revoke the admin flag as a member's role changes.
 *
 * Acts only on a transition across the admin-granting boundary; a change
 * between two roles on the same side of it leaves the flag alone.
 */
export async function syncAdminFlagOnUpdateMemberRole(
  args: {
    member: { role: string };
    previousRole: string;
    user: MemberIdentity;
    organization: { slug: string };
  },
  deps: AdminFlagSyncDeps
): Promise<void> {
  try {
    if (!appliesToDefaultOrganization(args.organization.slug, deps.defaultOrgSlug)) return;

    const shouldHaveAdmin = grantsAdminFlag(args.member.role);
    const previouslyHadAdmin = grantsAdminFlag(args.previousRole);
    const userId = args.user.id;

    if (shouldHaveAdmin && !previouslyHadAdmin) {
      await deps.setUserRole(userId, 'admin');
      console.log(`Granted admin role to user ${userId} (${args.user.email}) after promotion to ${args.member.role}`);
    } else if (!shouldHaveAdmin && previouslyHadAdmin) {
      await deps.setUserRole(userId, null);
      console.log(
        `Removed admin role from user ${userId} (${args.user.email}) after demotion from ${args.previousRole} to ${args.member.role}`
      );
    }
  } catch (error) {
    deps.onError(error);
  }
}

/**
 * Revoke the admin flag when a member leaves the default org, unless another
 * admin-granting membership still justifies it.
 */
export async function syncAdminFlagOnRemoveMember(
  args: { user: MemberIdentity; organization: { slug: string } },
  deps: AdminFlagSyncDeps & {
    hasOtherAdminMembership: (userId: string, defaultOrgSlug: string) => Promise<boolean>;
  }
): Promise<void> {
  try {
    if (!appliesToDefaultOrganization(args.organization.slug, deps.defaultOrgSlug)) return;

    // Narrowed by the guard above, which returns false when unset.
    const defaultOrgSlug = deps.defaultOrgSlug as string;

    if (!(await deps.hasOtherAdminMembership(args.user.id, defaultOrgSlug))) {
      const userId = args.user.id;
      await deps.setUserRole(userId, null);
      console.log(
        `Removed admin role from user ${userId} (${args.user.email}) after removal from default organization`
      );
    }
  } catch (error) {
    deps.onError(error);
  }
}
