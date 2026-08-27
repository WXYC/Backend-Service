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
import { normalizeRole } from './auth.roles';

/**
 * Does this membership role justify the admin flag?
 *
 * Exported and re-used as the ONE definition of that question: the
 * revocation-side twin in `auth.definition.ts` (`hasOtherAdminMembership`),
 * `provision-user.ts`, and `scripts/backfill-missing-org-members.ts` each
 * carried a verbatim `['stationManager', 'admin', 'owner']` copy of this set
 * before BS#2282. Four copies of one predicate is how a grant path and a
 * revocation path come to disagree — the grant widening when `normalizeRole`
 * gained shared's alias table, while a hardcoded SQL IN-list did not.
 *
 * The flag means "holds stationManager authority", which is the one question
 * `normalizeRole` exists to answer: it resolves `stationManager` to itself and
 * better-auth's own `admin`/`owner` organization roles to `stationManager`,
 * leaving `dj`/`musicDirector`/`member` as themselves. Asking it here rather
 * than restating the role set keeps this in step with `auth.roles.ts`, which
 * already declares that mapping canonical.
 */
export const grantsAdminFlag = (memberRole: string): boolean => normalizeRole(memberRole) === 'stationManager';

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

/** Removal additionally needs to know whether a second membership still justifies the flag. */
export interface RemoveMemberDeps extends AdminFlagSyncDeps {
  hasOtherAdminMembership: (userId: string, defaultOrgSlug: string) => Promise<boolean>;
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
  deps: RemoveMemberDeps
): Promise<void> {
  try {
    if (!appliesToDefaultOrganization(args.organization.slug, deps.defaultOrgSlug)) return;

    // The guard above passed, so this slug equals deps.defaultOrgSlug — and it
    // is already a string, which deps.defaultOrgSlug is not.
    if (!(await deps.hasOtherAdminMembership(args.user.id, args.organization.slug))) {
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
