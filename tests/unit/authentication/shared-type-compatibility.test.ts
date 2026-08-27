import { WXYCRoles, normalizeRole, type WXYCRole } from '../../../shared/authentication/src/auth.roles';
import {
  Authorization,
  ROLE_ALIASES,
  roleToAuthorization,
  type WXYCRole as SharedWXYCRole,
} from '@wxyc/shared/auth-client/auth';

describe('shared type compatibility', () => {
  describe('WXYCRoles alignment', () => {
    it.each(Object.keys(WXYCRoles) as WXYCRole[])('"%s" is a valid SharedWXYCRole', (role) => {
      // Every role in Backend-Service's WXYCRoles must be a valid shared WXYCRole.
      // This is also enforced at compile time by the type assertion in auth.roles.ts.
      const sharedRole: SharedWXYCRole = role;
      expect(sharedRole).toBe(role);
    });
  });

  describe('Authorization enum', () => {
    it('has expected values', () => {
      expect(Authorization.NO).toBe(0);
      expect(Authorization.DJ).toBe(1);
      expect(Authorization.MD).toBe(2);
      expect(Authorization.SM).toBe(3);
    });
  });

  describe('normalizeRole consistency with roleToAuthorization', () => {
    it('admin normalizes to stationManager, consistent with shared SM mapping', () => {
      expect(normalizeRole('admin')).toBe('stationManager');
      // Shared maps "admin" to SM (3) — the highest station role.
      // Both grant full access; the normalization is a backend-specific concern.
      expect(roleToAuthorization('admin')).toBe(Authorization.SM);
    });

    it.each(['member', 'dj', 'musicDirector', 'stationManager'] as const)(
      '"%s" maps to the same Authorization via both paths',
      (role) => {
        // Direct shared mapping
        const sharedAuth = roleToAuthorization(role);
        // Backend path: normalizeRole returns the role as-is, then shared maps it
        const normalized = normalizeRole(role);
        expect(normalized).toBe(role);
        expect(normalized).toBeDefined();
        if (normalized) {
          expect(roleToAuthorization(normalized)).toBe(sharedAuth);
        }
      }
    );
  });

  /**
   * `normalizeRole` delegates to `@wxyc/shared`'s alias table, which means the
   * table now lives behind a caret-ranged dependency: a shared 5.x that adds an
   * alias would reach Backend-Service as a lockfile-only bump, with no diff a
   * BS reviewer sees next to `grantsAdminFlag` — and that predicate decides the
   * global `auth_user.role='admin'` grant. Spot checks cannot catch a NEW
   * alias, so the guard is exhaustive: pin the whole table, and pin the
   * case-fold/trim that runs in front of it.
   *
   * A red test here after a dependency bump is the intended signal, not a
   * breakage: re-read the widening, decide whether it's wanted on the admin
   * path, then update this pin deliberately.
   */
  describe('role alias table (exhaustive pin against @wxyc/shared)', () => {
    it('is exactly the accepted-input map Backend-Service expects', () => {
      expect(ROLE_ALIASES).toEqual({
        admin: 'stationManager',
        owner: 'stationManager',
        stationmanager: 'stationManager',
        station_manager: 'stationManager',
        musicdirector: 'musicDirector',
        music_director: 'musicDirector',
        'music-director': 'musicDirector',
        dj: 'dj',
        member: 'member',
      });
    });

    // The fold in front of the lookup, pinned through BS's own consumer.
    const foldAccepted: [string, WXYCRole][] = [
      ['STATION_MANAGER', 'stationManager'],
      [' admin ', 'stationManager'],
      ['Owner', 'stationManager'],
      ['MusicDirector', 'musicDirector'],
      ['DJ', 'dj'],
    ];

    it.each(foldAccepted)('normalizeRole(%j) === %j (case-fold + trim)', (input, expected) => {
      expect(normalizeRole(input)).toBe(expected);
    });

    const foldRejected = [
      'user', // better-auth's global default role is not a station role
      'station-manager', // historical asymmetry: music-director resolves, this does not
      'station manager',
      'unknown',
      'administrator',
      // Prototype keys: `role in WXYCRoles` used to resolve these, and
      // requirePermissions then crashed calling .authorize on
      // Object.prototype.toString (a 500). Fail-closed is the contract.
      'toString',
      'constructor',
      '__proto__',
    ];

    it.each(foldRejected)('normalizeRole(%j) is undefined (fails closed)', (input) => {
      expect(normalizeRole(input)).toBeUndefined();
    });
  });
});
