import { adminAc } from 'better-auth/plugins/organization/access';
import {
  WXYCRoles,
  normalizeRole,
  WXYC_GRANTS,
  ORG_ADMIN_GRANTS,
  STATEMENT_ACTIONS,
  STATEMENT_KEYS,
  STATION_KEYS,
  type WXYCRole,
} from '../../../shared/authentication/src/auth.roles';
import { ROLES } from '@wxyc/shared/auth-client/auth';

/**
 * Actions granted for `key`, from whichever block owns it. `[]` = explicitly denied.
 *
 * `Object.hasOwn`, not `key in ...` — the same one-word difference this change
 * makes at `normalizeRole` and `provision-user.ts`, and it matters more here
 * than it looks. This helper is the oracle for the monotonicity, totality, and
 * runtime-parity suites below, so a statement key named `constructor` or
 * `valueOf` would make `in` return a prototype *function* instead of an action
 * array, and `for (const action of ...)` would throw — the three suites would
 * error out rather than report the grant inversion they exist to catch.
 */
const grantedActions = (role: WXYCRole, key: string): readonly string[] => {
  if (Object.hasOwn(WXYC_GRANTS[role], key)) {
    return WXYC_GRANTS[role][key as keyof (typeof WXYC_GRANTS)[typeof role]];
  }
  return role === 'stationManager' ? ((ORG_ADMIN_GRANTS as Record<string, readonly string[]>)[key] ?? []) : [];
};

// Derived from `statement` itself, never restated. A hardcoded list here would
// exempt every newly added key from the monotonicity check below — i.e. exempt
// it at exactly the moment the check exists for. (Verified: with a literal
// list, adding `roster` with `dj: ['write']` and `stationManager: []` passed
// monotonicity, totality, and parity green — the DJ-200/SM-403 inversion this
// file is built to kill, reintroduced silently.)
const allStatementKeys: string[] = STATEMENT_KEYS;

describe('normalizeRole', () => {
  it.each(['member', 'dj', 'musicDirector', 'stationManager'] as const)(
    'should return "%s" as-is (valid WXYC role)',
    (role) => {
      expect(normalizeRole(role)).toBe(role);
    }
  );

  it('should map "admin" to "stationManager"', () => {
    expect(normalizeRole('admin')).toBe('stationManager');
  });

  it('should map "owner" to "stationManager"', () => {
    expect(normalizeRole('owner')).toBe('stationManager');
  });

  it('should return undefined for an unrecognized role', () => {
    expect(normalizeRole('unknown')).toBeUndefined();
  });
});

describe('WXYCRoles', () => {
  const allRoles = Object.keys(WXYCRoles) as WXYCRole[];

  it.each(allRoles)('"%s" should have an authorize function', (role) => {
    const roleDef = WXYCRoles[role];
    expect(typeof (roleDef as any).authorize).toBe('function');
  });

  it.each(allRoles)('"%s" should authorize catalog:read', (role) => {
    const roleDef = WXYCRoles[role];
    const result = (roleDef as any).authorize({ catalog: ['read'] });
    expect(result.success).toBe(true);
  });

  it('member should NOT authorize catalog:write', () => {
    const result = (WXYCRoles.member as any).authorize({ catalog: ['write'] });
    expect(result.success).toBe(false);
  });

  it('stationManager should authorize catalog:write', () => {
    const result = (WXYCRoles.stationManager as any).authorize({
      catalog: ['write'],
    });
    expect(result.success).toBe(true);
  });
});

/**
 * Pins every constructed role's `.statements` to its exact current value.
 *
 * This is the red-green safety net for replacing the `...adminAc.statements`
 * spread with an explicit block: the refactor is only correct if these stay
 * byte-identical. It runs under `tests/mocks/better-auth-org-access.mock.ts`
 * (jest.unit.config.ts maps the real ESM module), so it does NOT see a
 * better-auth upgrade — `scripts/check-better-auth-mock-sync.ts` is what
 * guards library drift. Both are needed; neither alone means what it looks like.
 */
describe('role statements (pinned)', () => {
  // `member` has no `reviews` entry here on purpose: it decides the key as `[]`
  // in the matrix, and `stripEmpty` drops an explicitly-denied key before
  // better-auth ever sees it. That is what keeps an `[]` denial byte-identical
  // to omitting the key, and this pin is where that stays true.
  const wxycOnly = {
    member: { bin: ['read', 'write'], catalog: ['read'], flowsheet: ['read'] },
    dj: {
      bin: ['read', 'write'],
      catalog: ['read'],
      flowsheet: ['read', 'write'],
      album_reviews: ['read'],
      digital_archive: ['listen'],
    },
    musicDirector: {
      bin: ['read', 'write'],
      catalog: ['read', 'write'],
      flowsheet: ['read', 'write', 'manage'],
      album_reviews: ['read'],
      digital_archive: ['listen'],
    },
  } as const;

  it.each(Object.keys(wxycOnly) as (keyof typeof wxycOnly)[])(
    '%s carries exactly its granted station-domain keys and no org-admin keys',
    (role) => {
      expect({ ...(WXYCRoles[role] as any).statements }).toEqual(wxycOnly[role]);
    }
  );

  it('stationManager carries the station-domain keys plus better-auth org administration', () => {
    expect({ ...(WXYCRoles.stationManager as any).statements }).toEqual({
      ...adminAc.statements,
      bin: ['read', 'write'],
      catalog: ['read', 'write'],
      flowsheet: ['read', 'write', 'manage'],
      album_reviews: ['read'],
      digital_archive: ['listen'],
    });
  });

  it('the explicit ORG_ADMIN_GRANTS block equals better-auth adminAc.statements', () => {
    expect({ ...ORG_ADMIN_GRANTS }).toEqual({ ...adminAc.statements });
  });

  /**
   * A constructed role must hold COPIES of the grant data, never the matrix's
   * own arrays.
   *
   * `WXYC_GRANTS` and `ORG_ADMIN_GRANTS` are exported, and `index.ts` re-exports
   * them from `@wxyc/authentication`, so they are reachable public API. Before
   * `buildRole` cloned, `stripEmpty`'s `Object.entries` and the
   * `ORG_ADMIN_GRANTS` spread both passed references straight through, making
   * `dj.statements.flowsheet` the very array `WXYC_GRANTS.dj.flowsheet` names.
   * A single `push('manage')` anywhere in-process then granted every DJ the
   * operator tier behind `POST /flowsheet/shows/:id/force-end` — live, no
   * restart, no diff near this file. `as const` is compile-time only and does
   * not survive to runtime to stop it.
   *
   * Identity is the assertion, not equality: equality is what the pins above
   * already cover, and it stays true in exactly the aliased case this forbids.
   */
  it.each(Object.keys(WXYCRoles) as WXYCRole[])(
    '%s statements are copies of the station grants, not aliases',
    (role) => {
      const statements = (WXYCRoles[role] as any).statements;
      // Derived from STATION_KEYS rather than a literal list, for the reason
      // `allStatementKeys` gives: a hardcoded list exempts a newly added key
      // from the aliasing check at the moment it is introduced. An explicitly
      // denied (`[]`) key is skipped — `stripEmpty` removes it before
      // construction, so there is no constructed array for it to alias.
      for (const key of STATION_KEYS) {
        const matrixActions = (WXYC_GRANTS[role] as Record<string, readonly string[]>)[key];
        if (matrixActions.length === 0) {
          expect(statements[key]).toBeUndefined();
          continue;
        }
        expect(statements[key]).toEqual(matrixActions);
        expect(statements[key]).not.toBe(matrixActions);
      }
    }
  );

  it('stationManager statements are copies of the org-admin grants, not aliases', () => {
    const statements = (WXYCRoles.stationManager as any).statements;
    for (const [key, actions] of Object.entries(ORG_ADMIN_GRANTS as Record<string, readonly string[]>)) {
      expect(statements[key]).toEqual(actions);
      expect(statements[key]).not.toBe(actions);
    }
  });
});

/**
 * The role chain is a checked invariant on the data, never a runtime fallback:
 * `requirePermissions` stays a pure per-role check. This is what makes the
 * documented hierarchy true rather than folklore, and it structurally kills the
 * inversion class where a new key is granted to dj but forgotten on
 * stationManager (a DJ 200 alongside an SM 403).
 */
describe('grant monotonicity along the shared ROLES chain', () => {
  // ROLES is highest-first; walk adjacent pairs from the bottom up.
  const ascending = [...ROLES].reverse() as WXYCRole[];
  const pairs = ascending.slice(0, -1).map((lower, i) => [lower, ascending[i + 1]] as const);

  it.each(pairs)('%s grants are a subset of %s grants, per key', (lower, higher) => {
    for (const key of allStatementKeys) {
      const lowerActions = grantedActions(lower, key);
      const higherActions = grantedActions(higher, key);
      for (const action of lowerActions) {
        expect(higherActions).toContain(action);
      }
    }
  });
});

describe('every statement key is decided for every role', () => {
  it.each(Object.keys(WXYCRoles) as WXYCRole[])('%s decides all station-domain keys', (role) => {
    // Totality over the station domain is enforced by the type system; this
    // asserts the runtime shape agrees. Because STATION_KEYS is derived from
    // `statement`, it genuinely catches a key added there but never routed
    // into a grant block — which a literal key list could not.
    for (const key of STATION_KEYS) {
      expect(Object.keys(WXYC_GRANTS[role])).toContain(key);
    }
  });
});

/**
 * Proves the better-auth adapter faithfully reflects the data: an `[]`-decided
 * key must fail authorize (the empty-strip adapter and the matrix agree), and
 * every granted action must succeed.
 */
describe('runtime parity: authorize() agrees with the grant data', () => {
  const triples = (Object.keys(WXYCRoles) as WXYCRole[]).flatMap((role) =>
    allStatementKeys.flatMap((key) => {
      const granted = grantedActions(role, key);
      // Every action `statement` declares for this key — derived, so a new key
      // or a new action on an existing key is covered the moment it is added.
      const universe = [...new Set([...granted, ...(STATEMENT_ACTIONS[key] ?? [])])];
      return universe.map((action) => ({ role, key, action, expected: granted.includes(action) }));
    })
  );

  it.each(triples)('$role / $key:$action -> $expected', ({ role, key, action, expected }) => {
    const result = (WXYCRoles[role] as any).authorize({ [key]: [action] });
    expect(result.success).toBe(expected);
  });
});
