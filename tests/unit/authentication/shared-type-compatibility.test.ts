import {
  WXYCRoles,
  normalizeRole,
  type WXYCRole,
} from '../../../shared/authentication/src/auth.roles';
import {
  Authorization,
  roleToAuthorization,
  type WXYCRole as SharedWXYCRole,
} from '@wxyc/shared/auth-client/auth';

describe('shared type compatibility', () => {
  describe('WXYCRoles alignment', () => {
    it.each(Object.keys(WXYCRoles) as WXYCRole[])(
      '"%s" is a valid SharedWXYCRole',
      (role) => {
        // Every role in Backend-Service's WXYCRoles must be a valid shared WXYCRole.
        // This is also enforced at compile time by the type assertion in auth.roles.ts.
        const sharedRole: SharedWXYCRole = role;
        expect(sharedRole).toBe(role);
      },
    );
  });

  describe('Authorization enum', () => {
    it('has expected values', () => {
      expect(Authorization.NO).toBe(0);
      expect(Authorization.DJ).toBe(1);
      expect(Authorization.MD).toBe(2);
      expect(Authorization.SM).toBe(3);
      expect(Authorization.ADMIN).toBe(4);
    });
  });

  describe('normalizeRole consistency with roleToAuthorization', () => {
    it('admin normalizes to stationManager, consistent with shared ADMIN >= SM', () => {
      expect(normalizeRole('admin')).toBe('stationManager');
      // Shared maps "admin" to ADMIN (4), which is >= SM (3).
      // Both grant full access; the normalization is a backend-specific concern.
      expect(roleToAuthorization('admin')).toBe(Authorization.ADMIN);
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
      },
    );
  });
});
