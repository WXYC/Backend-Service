/**
 * Comparator for the better-auth access mocks.
 *
 * The unit suite never runs real better-auth: `jest.unit.config.ts` maps
 * `better-auth/plugins/access` and `better-auth/plugins/organization/access`
 * to hand-written mocks, because ts-jest can't transform better-auth's ESM.
 * That makes every unit-level assertion about roles an assertion about the
 * *mock* — including the `adminAc.statements` pin in auth.roles.test.ts, which
 * would otherwise be comparing the mock to itself and could never notice a
 * library upgrade.
 *
 * This function is the missing half: run it against the real modules and the
 * mocks together (see `scripts/check-better-auth-mock-sync.ts`) and a
 * better-auth upgrade that changes the org-admin statement set or `authorize`
 * semantics fails loudly instead of silently invalidating the unit suite.
 *
 * It lives here, not in `scripts/`, because `scripts/**` is excluded from both
 * ESLint (`eslint.config.mjs` global ignores) and `npm run typecheck` — a
 * comparator whose failure mode is "passes silently forever" must not itself
 * be the one unverified file in the repo. The runner in `scripts/` stays thin.
 */

export interface AccessModule {
  createAccessControl: (statements: Record<string, readonly string[]>) => {
    newRole: (permissions: Record<string, readonly string[]>) => {
      authorize: (request: Record<string, string[]>) => { success: boolean };
      statements: Record<string, readonly string[]>;
    };
  };
}

export interface OrgAccessModule {
  defaultStatements: Record<string, readonly string[]>;
  adminAc: { statements: Record<string, readonly string[]> };
}

export interface ParityFinding {
  kind: 'statements' | 'authorize';
  detail: string;
}

const sortedEntries = (value: Record<string, readonly string[]>): [string, string[]][] =>
  Object.entries(value)
    .map(([key, actions]) => [key, [...actions].sort()] as [string, string[]])
    .sort(([a], [b]) => a.localeCompare(b));

const canonical = (value: Record<string, readonly string[]>): string => JSON.stringify(sortedEntries(value));

/** Compares one statement map, reporting a finding when they diverge. */
const compareStatementMap = (
  label: string,
  real: Record<string, readonly string[]>,
  mock: Record<string, readonly string[]>
): ParityFinding[] =>
  canonical(real) === canonical(mock)
    ? []
    : [
        {
          kind: 'statements' as const,
          detail: `${label} differs.\n  real: ${canonical(real)}\n  mock: ${canonical(mock)}`,
        },
      ];

/**
 * Compares the real better-auth access modules against the repo's mocks.
 *
 * Checks the two statement maps the roles are built from, then runs every
 * (role-shape, resource, action) triple through both implementations'
 * `authorize` and asserts the `success` verdicts agree. Note the deliberate
 * scope: only `success` is compared, never the error strings — better-auth
 * distinguishes an absent resource from an empty one in its message
 * (`unknownResourceResponse` vs `unauthorizedResourceResponse`) and the mock
 * does not model that. `auth.roles.ts` strips empty grants before
 * construction precisely so no role ever depends on that distinction.
 *
 * @returns findings; an empty array means the mocks faithfully stand in.
 */
export function compareAccessModules(
  real: { access: AccessModule; orgAccess: OrgAccessModule },
  mock: { access: AccessModule; orgAccess: OrgAccessModule }
): ParityFinding[] {
  const findings: ParityFinding[] = [
    ...compareStatementMap('defaultStatements', real.orgAccess.defaultStatements, mock.orgAccess.defaultStatements),
    ...compareStatementMap('adminAc.statements', real.orgAccess.adminAc.statements, mock.orgAccess.adminAc.statements),
  ];

  // A statement vocabulary wide enough to exercise both the library-owned keys
  // and this repo's station-domain ones, including an action never granted.
  const statement: Record<string, readonly string[]> = {
    ...real.orgAccess.defaultStatements,
    catalog: ['read', 'write'],
    bin: ['read', 'write'],
    flowsheet: ['read', 'write', 'manage'],
  };

  const grantShapes: Record<string, readonly string[]>[] = [
    { catalog: ['read'], bin: ['read', 'write'], flowsheet: ['read'] },
    { catalog: ['read', 'write'], bin: ['read', 'write'], flowsheet: ['read', 'write', 'manage'] },
    { ...real.orgAccess.adminAc.statements, catalog: ['read', 'write'] },
    {},
  ];

  for (const [shapeIndex, grants] of grantShapes.entries()) {
    const realRole = real.access.createAccessControl(statement).newRole(grants);
    const mockRole = mock.access.createAccessControl(statement).newRole(grants);

    for (const [resource, actions] of Object.entries(statement)) {
      for (const action of actions) {
        const realVerdict = realRole.authorize({ [resource]: [action] }).success;
        const mockVerdict = mockRole.authorize({ [resource]: [action] }).success;
        if (realVerdict !== mockVerdict) {
          findings.push({
            kind: 'authorize',
            detail: `grant shape #${shapeIndex}: ${resource}:${action} — real=${realVerdict} mock=${mockVerdict}`,
          });
        }
      }
    }
  }

  return findings;
}
