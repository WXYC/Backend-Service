import { adminAc, defaultStatements } from 'better-auth/plugins/organization/access';
import {
  WXYCRoles,
  normalizeRole,
  WXYC_GRANTS,
  ORG_ADMIN_GRANTS,
  type WXYCRole,
} from '../../../shared/authentication/src/auth.roles';
import { ROLES } from '@wxyc/shared/auth-client/auth';

/** Actions granted for `key`, from whichever block owns it. `[]` = explicitly denied. */
const grantedActions = (role: WXYCRole, key: string): readonly string[] => {
  if (key in WXYC_GRANTS[role]) {
    return WXYC_GRANTS[role][key as keyof (typeof WXYC_GRANTS)[typeof role]];
  }
  return role === 'stationManager' ? ((ORG_ADMIN_GRANTS as Record<string, readonly string[]>)[key] ?? []) : [];
};

const allStatementKeys = [...Object.keys(defaultStatements), 'catalog', 'bin', 'flowsheet'];

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
  const wxycOnly = {
    member: { bin: ['read', 'write'], catalog: ['read'], flowsheet: ['read'] },
    dj: { bin: ['read', 'write'], catalog: ['read'], flowsheet: ['read', 'write'] },
    musicDirector: {
      bin: ['read', 'write'],
      catalog: ['read', 'write'],
      flowsheet: ['read', 'write', 'manage'],
    },
  } as const;

  it.each(Object.keys(wxycOnly) as (keyof typeof wxycOnly)[])(
    '%s carries exactly its three station-domain keys and no org-admin keys',
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
    });
  });

  it('the explicit ORG_ADMIN_GRANTS block equals better-auth adminAc.statements', () => {
    expect({ ...ORG_ADMIN_GRANTS }).toEqual({ ...adminAc.statements });
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
    // asserts the runtime shape agrees, and catches a key added to `statement`
    // but never routed into either grant block.
    for (const key of ['catalog', 'bin', 'flowsheet']) {
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
      const universe = [
        ...new Set([
          ...granted,
          ...((defaultStatements as Record<string, readonly string[]>)[key] ?? []),
          ...(key === 'flowsheet' ? ['read', 'write', 'manage'] : []),
          ...(key === 'catalog' || key === 'bin' ? ['read', 'write'] : []),
        ]),
      ];
      return universe.map((action) => ({ role, key, action, expected: granted.includes(action) }));
    })
  );

  it.each(triples)('$role / $key:$action -> $expected', ({ role, key, action, expected }) => {
    const result = (WXYCRoles[role] as any).authorize({ [key]: [action] });
    expect(result.success).toBe(expected);
  });
});
