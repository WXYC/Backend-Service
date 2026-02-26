import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/organization/access';

const statement = {
  ...defaultStatements,
  catalog: ['read', 'write'],
  bin: ['read', 'write'],
  flowsheet: ['read', 'write'],
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
  flowsheet: ['read', 'write'],
});

export const stationManager = accessControl.newRole({
  ...adminAc.statements,
  bin: ['read', 'write'],
  catalog: ['read', 'write'],
  flowsheet: ['read', 'write'],
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
