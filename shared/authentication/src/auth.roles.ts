import { defaultStatements, adminAc } from "better-auth/plugins/organization/access";
import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  ...defaultStatements,
  catalog: ["read", "write"],
  flowsheet: ["read", "write"]
} as const;

export type AccessControlStatement = typeof statement;

const accessControl = createAccessControl(statement);

export const member = accessControl.newRole({
  catalog: ["read"],
  flowsheet: ["read"]
});

export const dj = accessControl.newRole({
  catalog: ["read"],
  flowsheet: ["read", "write"]
});

export const musicDirector = accessControl.newRole({
  catalog: ["read", "write"],
  flowsheet: ["read", "write"]
});

export const stationManager = accessControl.newRole({
  ...adminAc.statements,
  catalog: ["read", "write"],
  flowsheet: ["read", "write"]
});

export const WXYCRoles = {
  member,
  dj,
  musicDirector,
  stationManager
}

export type WXYCRole = keyof typeof WXYCRoles;