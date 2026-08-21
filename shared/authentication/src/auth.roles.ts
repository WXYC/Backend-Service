import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/organization/access';

const statement = {
  ...defaultStatements,
  catalog: ['read', 'write'],
  bin: ['read', 'write'],
  // `manage` is the operator tier: acting on a show you are not a member of.
  // Held by musicDirector and stationManager, NOT by dj — which is what makes
  // it a distinct action rather than a reuse of `write` (every DJ has that).
  // It backs `GET /flowsheet/open-shows` and `POST
  // /flowsheet/shows/:id/force-end` (BS#2235), the Backend-Service replacement
  // for tubafrenzy's `EndShowServlet`, which any signed-on DJ could reach for
  // any recent show with no ownership check at all. Deliberately NOT expressed
  // as `catalog: ['write']` — that happens to select the same two roles today,
  // but it is the catalog's grant, and a future re-grant of catalog editing
  // would silently move who can close a stranger's show.
  //
  // Not mirrored into `@wxyc/shared`'s `RESOURCES`/`ROLE_PERMISSIONS` (which
  // already carries a `roster` resource this statement does not). Nothing
  // cross-repo consumes it: the JWT carries a role, not a permission set, and
  // this middleware resolves the role against the table below server-side.
  // dj-site gates its operator UI on `roleToAuthorization(...) >= MD`.
  flowsheet: ['read', 'write', 'manage'],
} as const;

export type AccessControlStatement = typeof statement;

const accessControl = createAccessControl(statement);

export const member = accessControl.newRole({
  bin: ['read', 'write'],
  catalog: ['read'],
  flowsheet: ['read'],
});

export const dj = accessControl.newRole({
  bin: ['read', 'write'],
  catalog: ['read'],
  flowsheet: ['read', 'write'],
});

export const musicDirector = accessControl.newRole({
  bin: ['read', 'write'],
  catalog: ['read', 'write'],
  flowsheet: ['read', 'write', 'manage'],
});

export const stationManager = accessControl.newRole({
  ...adminAc.statements,
  bin: ['read', 'write'],
  catalog: ['read', 'write'],
  flowsheet: ['read', 'write', 'manage'],
});

export const WXYCRoles = {
  member,
  dj,
  musicDirector,
  stationManager,
};

import type { WXYCRole } from '@wxyc/shared/auth-client/auth';
export type { WXYCRole } from '@wxyc/shared/auth-client/auth';
export { roleToAuthorization, Authorization } from '@wxyc/shared/auth-client/auth';

// Compile-time assertion: every role in WXYCRoles is a valid shared WXYCRole.
// The reverse is intentionally not asserted -- shared includes "admin", which
// Backend-Service maps to "stationManager" via normalizeRole() rather than
// defining as a separate better-auth role.
type _AssertLocalRolesAreShared = [keyof typeof WXYCRoles] extends [WXYCRole] ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _localRolesValid: _AssertLocalRolesAreShared = true;

/** The set of roles that have a better-auth access control implementation. */
export type ImplementedRole = keyof typeof WXYCRoles;

/** Maps better-auth system roles to their WXYC equivalent. */
const systemRoleMap: Record<string, ImplementedRole> = {
  admin: 'stationManager',
  owner: 'stationManager',
};

/** Normalizes a role string to an implemented role, mapping better-auth system roles. */
export function normalizeRole(role: string): ImplementedRole | undefined {
  if (role in WXYCRoles) return role as ImplementedRole;
  return systemRoleMap[role];
}
