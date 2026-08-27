import { createAccessControl } from 'better-auth/plugins/access';
// `adminAc` is deliberately NOT imported: replacing the `...adminAc.statements`
// spread with the explicit `ORG_ADMIN_GRANTS` block below is the point of this
// file's construction, and the pin that keeps the two equal lives in
// tests/unit/authentication/auth.roles.test.ts, where importing it is correct.
import { defaultStatements } from 'better-auth/plugins/organization/access';

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
  // There is nowhere cross-repo to mirror this to, and that is now structural
  // rather than incidental: as of `@wxyc/shared` 5.0.0 — the bump this file
  // ships with — shared exports no grant table at all. Its auth surface is
  // `ROLES`, `ROLE_ALIASES`, `canonicalizeRole`, `roleToAuthorization`,
  // `Authorization`, and the capability helpers; the client-side
  // `RESOURCES`/`ROLE_PERMISSIONS` pair an earlier version carried is gone.
  // Shared owns role identity and order, this file owns the ONLY grant matrix.
  //
  // Nothing cross-repo needs it anyway: the JWT carries a role, not a
  // permission set, and the middleware resolves that role against the matrix
  // below server-side. dj-site gates its operator UI on
  // `roleToAuthorization(...) >= MD`.
  flowsheet: ['read', 'write', 'manage'],
} as const;

export type AccessControlStatement = typeof statement;

/**
 * The statement vocabulary, exported so the invariant tests derive their key
 * list from it rather than restating it.
 *
 * This is load-bearing, not convenience: a hardcoded key list in the tests
 * means a newly added key is silently exempt from the monotonicity check — the
 * one moment the check exists for. With the list derived, adding `roster` here
 * puts it under the invariant immediately.
 */
export const STATEMENT_KEYS = Object.keys(statement) as (keyof AccessControlStatement)[];

/** The full vocabulary: every declarable action, per key. Read by the tests. */
export const STATEMENT_ACTIONS: Readonly<Record<string, readonly string[]>> = statement;

/** The station-domain keys — those `statement` adds beyond better-auth's own. */
export const STATION_KEYS = STATEMENT_KEYS.filter((key) => !Object.hasOwn(defaultStatements, key)) as Exclude<
  keyof AccessControlStatement,
  keyof typeof defaultStatements
>[];

const accessControl = createAccessControl(statement);

import { canonicalizeRole, type WXYCRole } from '@wxyc/shared/auth-client/auth';
export type { WXYCRole } from '@wxyc/shared/auth-client/auth';
export { roleToAuthorization, Authorization } from '@wxyc/shared/auth-client/auth';

/** The station-domain half of the statement: everything better-auth doesn't own. */
type StationKey = Exclude<keyof AccessControlStatement, keyof typeof defaultStatements>;

/**
 * A grant row: every station-domain key decided, and — critically — each one
 * constrained to the actions `statement` actually declares for that key.
 *
 * The action constraint is not decoration. Typing the values as a loose
 * `readonly string[]` would make `flowsheet: ['read', 'write', 'mange']`
 * compile, and no test would catch it: monotonicity only notices a typo when a
 * *lower* role spells the action correctly, so a typo introduced on
 * stationManager alone — or applied down a whole column — reaches production as
 * a 403. better-auth's own `newRole` signature enforces this; deriving the
 * constraint from `AccessControlStatement` keeps it after the matrix took over
 * construction.
 */
type StationGrants = { [K in StationKey]: readonly AccessControlStatement[K][number][] };

/** Same, for the library-owned org-administration keys stationManager holds. */
type OrgAdminGrants = {
  [K in keyof typeof defaultStatements]?: readonly (typeof defaultStatements)[K][number][];
};

/**
 * The grant matrix — the single source of truth for what each role may do,
 * as plain data rather than four hand-built `newRole` calls.
 *
 * Two properties this shape buys, both of which the old spread-based
 * construction lacked:
 *
 * 1. **Totality by type.** Every role must decide every station-domain key;
 *    an empty array is an explicit denial. Adding a key to `statement` above
 *    without deciding it for all four roles is a compile error, not a
 *    discovered-in-production 403.
 * 2. **Monotonicity by test.** `tests/unit/authentication/auth.roles.test.ts`
 *    asserts each role's grants are a superset of the role below it along
 *    `@wxyc/shared`'s `ROLES` chain. The chain is an invariant on this data,
 *    NOT a runtime fallback — `requirePermissions` remains a pure per-role
 *    check, which is what keeps `flowsheet: ['manage']` meaningful (see its
 *    rationale above).
 *
 * Keyed on shared's `WXYCRole` rather than a local `ImplementedRole`: the
 * latter now derives FROM this object, so keying on it would be circular and
 * TypeScript would silently degrade the whole matrix to `any`, taking the
 * totality guarantee with it. Shared owns role identity; this file owns grants.
 */
const WXYC_GRANTS = {
  member: {
    bin: ['read', 'write'],
    catalog: ['read'],
    flowsheet: ['read'],
  },
  dj: {
    bin: ['read', 'write'],
    catalog: ['read'],
    flowsheet: ['read', 'write'],
  },
  musicDirector: {
    bin: ['read', 'write'],
    catalog: ['read', 'write'],
    flowsheet: ['read', 'write', 'manage'],
  },
  stationManager: {
    bin: ['read', 'write'],
    catalog: ['read', 'write'],
    flowsheet: ['read', 'write', 'manage'],
  },
} as const satisfies Record<WXYCRole, StationGrants>;

/**
 * better-auth's own org-administration grants, held by stationManager alone.
 *
 * This was `...adminAc.statements` spread into the stationManager role, which
 * read as "stationManager gets everything" and is nothing of the sort: it is a
 * fixed library-owned key set (organization/member/invitation/team/ac) that
 * confers NO custom key. A key added to `statement` and granted to dj but
 * trusted to arrive here via the spread produced the exact inversion this
 * file's tests now forbid — a plain DJ authorized while the station manager
 * 403s. Writing the set out removes the illusion; the pin test
 * (`ORG_ADMIN_GRANTS equals adminAc.statements`) keeps it honest, and
 * `scripts/check-better-auth-mock-sync.ts` catches a library upgrade that
 * changes what "honest" means.
 */
const ORG_ADMIN_GRANTS = {
  organization: ['update'],
  invitation: ['create', 'cancel'],
  member: ['create', 'update', 'delete'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
} as const satisfies OrgAdminGrants;

export { WXYC_GRANTS, ORG_ADMIN_GRANTS };

/**
 * Freezes the grant blocks and the statement vocabulary, arrays included.
 *
 * All three are exported and re-exported from `@wxyc/authentication`, so they
 * are reachable, mutable public API, and `as const` is erased at runtime.
 * `buildRole` already clones, so a mutation here can no longer change an
 * authorization verdict — but freezing closes the class rather than the one
 * instance of it, and it is what keeps `STATEMENT_ACTIONS` honest as the
 * oracle the invariant tests read. Module scope is strict, so a `push` on a
 * frozen array throws rather than failing silently.
 *
 * Runs before the roles are constructed below; better-auth only reads these.
 */
const deepFreeze = <T extends object>(value: T): T => {
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === 'object') deepFreeze(entry);
  }
  return Object.freeze(value);
};

deepFreeze(statement);
deepFreeze(WXYC_GRANTS);
deepFreeze(ORG_ADMIN_GRANTS);

/**
 * Drops explicitly-denied (`[]`) keys before handing grants to better-auth.
 *
 * better-auth treats an absent key and an empty one identically for
 * `authorize().success`, but NOT for `role.statements` or the error string it
 * produces (`unknownResourceResponse` vs `unauthorizedResourceResponse`), and
 * the organization plugin surfaces those strings through its own
 * `hasPermission`. Stripping keeps every constructed role byte-identical to
 * the pre-matrix construction. No `[]` cells exist today; this is what makes a
 * future explicit denial free of side effects.
 */
const stripEmpty = (grants: Record<string, readonly string[]>): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(grants).filter(([, actions]) => actions.length > 0));

// WHERE ACTION VALIDITY IS ENFORCED — read this before touching either block.
//
// It is the `as const satisfies` clauses above, and ONLY those. `stripEmpty`
// widens to a string-keyed record, so by the time grants reach `newRole` they
// are `Record<string, readonly string[]>` and better-auth's generic has already
// instantiated at its constraint; nothing at this call site can still tell
// `'manage'` from `'mange'`. Verified by removing `satisfies Record<WXYCRole,
// StationGrants>` and typo'ing `'mange'` into stationManager: `tsc --noEmit`
// exits 0. With the clause in place the same typo is a TS2820.
//
// So: do not drop a `satisfies` clause on the grounds that the construction
// below re-derives the types. It does not. (This replaced an
// `as Parameters<typeof newRole>[0]` cast, which was worse — it disabled the
// check better-auth's own signature would otherwise have applied — but
// removing that cast is not what restores the guarantee.)
//
// Each action list is COPIED, never aliased. `stripEmpty`'s `Object.entries`
// hands back the very arrays `WXYC_GRANTS` holds, and `ORG_ADMIN_GRANTS` is
// spread by reference, so without the clones a constructed role's
// `.statements.flowsheet` would BE `WXYC_GRANTS.dj.flowsheet` — and these are
// public exports of `@wxyc/authentication`. A single
// `WXYC_GRANTS.dj.flowsheet.push('manage')` anywhere in-process would hand
// every DJ the operator tier backing `POST /flowsheet/shows/:id/force-end`,
// live, with no restart. `as const` is erased at runtime and stops none of it.
const clone = (grants: Record<string, readonly string[]>): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(grants).map(([key, actions]) => [key, [...actions]]));

// Both blocks go through `stripEmpty`, not just the station one. `OrgAdminGrants`
// is a `Partial<...>` of `readonly string[]`, so `organization: []` compiles
// there exactly as it does in `WXYC_GRANTS` — and an un-stripped `[]` reaching
// `newRole` lands on better-auth's `unauthorizedResourceResponse` instead of
// `unknownResourceResponse`, which is the one distinction `stripEmpty` exists
// to keep no role depending on. Stripping one block and not the other would
// make "an `[]` denial is free of side effects" true in half this file.
const buildRole = (role: WXYCRole) => {
  const grants = {
    ...clone(stripEmpty(WXYC_GRANTS[role])),
    ...(role === 'stationManager' ? clone(stripEmpty(ORG_ADMIN_GRANTS)) : {}),
  };
  return accessControl.newRole(grants);
};

export const member = buildRole('member');
export const dj = buildRole('dj');
export const musicDirector = buildRole('musicDirector');
export const stationManager = buildRole('stationManager');

export const WXYCRoles = {
  member,
  dj,
  musicDirector,
  stationManager,
};

/** The set of roles that have a better-auth access control implementation. */
export type ImplementedRole = keyof typeof WXYC_GRANTS;

/**
 * Normalizes a role string to an implemented role.
 *
 * Delegates to `@wxyc/shared`'s `canonicalizeRole` — the org's single alias
 * table — rather than keeping a fourth local copy. Two deliberate deltas from
 * the `systemRoleMap` + `role in WXYCRoles` version this replaces:
 *
 * - **Wider:** case variants and `station_manager`/`music_director`/
 *   `music-director` now resolve. This reaches `grantsAdminFlag` in
 *   admin-flag-sync.ts, i.e. the global `auth_user.role='admin'` grant — but no
 *   write path can store such a value (`provisionUser` validates against
 *   `WXYCRoles`' own keys, better-auth's org role update against its
 *   configured roles), so it is unreachable in stored data. Pinned either way
 *   in tests/unit/authentication/shared-type-compatibility.test.ts.
 * - **Narrower:** `role in WXYCRoles` walked the prototype chain, so
 *   `normalizeRole('toString')` returned a truthy non-role and
 *   `requirePermissions` then crashed calling `.authorize` on
 *   `Object.prototype.toString` — a 500 where every other invalid role gets a
 *   403. Prototype keys now fail closed like anything else.
 */
export function normalizeRole(role: string): ImplementedRole | undefined {
  return canonicalizeRole(role);
}
