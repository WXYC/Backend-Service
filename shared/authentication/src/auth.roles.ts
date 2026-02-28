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

export type WXYCRole = keyof typeof WXYCRoles;

/** Maps better-auth system roles to their WXYC equivalent. */
const systemRoleMap: Record<string, WXYCRole> = {
  admin: 'stationManager',
  owner: 'stationManager',
};

/** Normalizes a role string to a WXYCRole, mapping better-auth system roles. */
export function normalizeRole(role: string): WXYCRole | undefined {
  if (role in WXYCRoles) return role as WXYCRole;
  return systemRoleMap[role];
}
