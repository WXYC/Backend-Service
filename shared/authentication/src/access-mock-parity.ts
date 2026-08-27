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

/**
 * A per-resource action request. better-auth accepts a bare action list or a
 * `{ actions, connector }` object, and the object form's connector flips the
 * per-resource check from `every` to `some` — so the two forms are not
 * interchangeable and both have to be compared.
 */
export type ActionRequest = string[] | { actions?: string[]; connector?: string };

export type AuthorizeRequest = Record<string, ActionRequest>;

export interface AccessModule {
  createAccessControl: (statements: Record<string, readonly string[]>) => {
    newRole: (permissions: Record<string, readonly string[]>) => {
      /** The second argument is the TOP-LEVEL connector, defaulting to `'AND'`. */
      authorize: (request: AuthorizeRequest, connector?: string) => { success: boolean };
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
 * (role-shape, request-shape, top-level-connector) combination through both
 * implementations' `authorize` and asserts the `success` verdicts agree. The
 * request shapes span the whole surface better-auth accepts, not just the one
 * `requirePermissions` sends: single (resource, action) pairs, the degenerate
 * empty-request and empty-action-list forms, the `{ actions, connector }`
 * object form, and multi-resource requests. Note the deliberate scope: only
 * `success` is compared, never the error strings. better-auth distinguishes an
 * absent resource from an empty one in its *message*
 * (`unknownResourceResponse` vs `unauthorizedResourceResponse`) and the mock
 * does not model that; `auth.roles.ts` strips empty grants before construction
 * precisely so no role ever depends on that distinction.
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

    const entries = Object.entries(statement);

    // Every declared (resource, action) pair, PLUS the degenerate, object-form
    // and multi-resource shapes. None of these are padding — each one is a
    // place a plausible mock diverges from the library:
    //
    // - The EMPTY shapes: `[]` is how `auth.roles.ts` spells an explicit
    //   denial, so an empty action list is the shape this comparator most
    //   needs to agree on. It was the one shape originally never sent, which
    //   let a genuine `success`-level divergence sit behind a green check
    //   (real: false, mock: true, both forms).
    // - The OBJECT form: `normalizeActionRequest` accepts `{ actions,
    //   connector }`, and a per-resource `connector: 'OR'` turns `every` into
    //   `some`. A mock that understands only the array form doesn't disagree
    //   quietly here — it throws — which is a failure mode this check should
    //   surface rather than a caller discover.
    // - The MULTI-RESOURCE shapes: the only ones where the top-level connector
    //   changes a verdict at all, since `AND` fails on the first unknown or
    //   unauthorized resource while `OR` skips unknowns and succeeds on any
    //   authorized one.
    const requests: [string, AuthorizeRequest][] = [
      ...entries.flatMap(([resource, actions]) =>
        actions.map((action) => [`${resource}:${action}`, { [resource]: [action] }] as [string, AuthorizeRequest])
      ),
      ['<empty request>', {}],
      ...entries.map(([resource]) => [`${resource}:<empty actions>`, { [resource]: [] }] as [string, AuthorizeRequest]),
      ...entries.flatMap(([resource, actions]): [string, AuthorizeRequest][] => {
        const all = [...actions];
        return [
          [`${resource}:{actions}`, { [resource]: { actions: all } }],
          [`${resource}:{actions,OR}`, { [resource]: { actions: all, connector: 'OR' } }],
          [`${resource}:{actions:[],OR}`, { [resource]: { actions: [], connector: 'OR' } }],
          // `actions` absent entirely — normalizes to the empty list, so this
          // must deny rather than throw or pass vacuously.
          [`${resource}:{}`, { [resource]: {} }],
        ];
      }),
      ...(entries.length > 1
        ? ([
            [
              `${entries[0][0]}+${entries[entries.length - 1][0]}`,
              {
                [entries[0][0]]: [...entries[0][1]],
                [entries[entries.length - 1][0]]: [...entries[entries.length - 1][1]],
              },
            ],
            [`${entries[0][0]}+<unknown resource>`, { [entries[0][0]]: [...entries[0][1]], __nonexistent__: ['read'] }],
            ['<unknown resource> only', { __nonexistent__: ['read'] }],
          ] as [string, AuthorizeRequest][])
        : []),
    ];

    // `undefined` exercises the default. better-auth compares the top-level
    // connector by identity (`=== 'AND'` / `=== 'OR'`) WITHOUT running it
    // through `normalizeConnector`, unlike the per-resource one — so a
    // lowercase `'or'` is a third behaviour rather than an alias, and that
    // asymmetry is pinned here so a mock can't quietly normalize it away.
    const connectors: (string | undefined)[] = [undefined, 'AND', 'OR', 'or'];

    for (const [label, request] of requests) {
      for (const connector of connectors) {
        const realVerdict = realRole.authorize(request, connector).success;
        const mockVerdict = mockRole.authorize(request, connector).success;
        if (realVerdict !== mockVerdict) {
          findings.push({
            kind: 'authorize',
            detail: `grant shape #${shapeIndex}: ${label} [connector=${connector ?? '<default>'}] — real=${realVerdict} mock=${mockVerdict}`,
          });
        }
      }
    }
  }

  return findings;
}
