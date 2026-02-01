import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/organization/access";

const statement = {
  ...defaultStatements,
  catalog: ["read", "write"],
  bin: ["read", "write"],
  flowsheet: ["read", "write"],
  roster: ["read", "write"],
} as const;

export type AccessControlStatement = typeof statement;

const accessControl = createAccessControl(statement);

export const member = accessControl.newRole({
  bin: ["read", "write"],
  catalog: ["read"],
  flowsheet: ["read"],
});

export const dj = accessControl.newRole({
  bin: ["read", "write"],
  catalog: ["read"],
  flowsheet: ["read", "write"],
});

export const musicDirector = accessControl.newRole({
  bin: ["read", "write"],
  catalog: ["read", "write"],
  flowsheet: ["read", "write"],
});

export const stationManager = accessControl.newRole({
  ...adminAc.statements,
  bin: ["read", "write"],
  catalog: ["read", "write"],
  flowsheet: ["read", "write"],
  roster: ["read", "write"],
});

export const admin = accessControl.newRole({
  ...adminAc.statements,
  bin: ["read", "write"],
  catalog: ["read", "write"],
  flowsheet: ["read", "write"],
  roster: ["read", "write"],
});

export const WXYCRoles = {
  member,
  dj,
  musicDirector,
  stationManager,
  admin,
};

export type WXYCRole = keyof typeof WXYCRoles;
