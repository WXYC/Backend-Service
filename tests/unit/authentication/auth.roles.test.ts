import { WXYCRoles, type WXYCRole } from '../../../shared/authentication/src/auth.roles';

describe('WXYCRoles', () => {
  const allRoles = Object.keys(WXYCRoles) as WXYCRole[];

  it('should include the admin role', () => {
    expect(WXYCRoles).toHaveProperty('admin');
  });

  /**
   * These are the roles that better-auth's organization plugin and
   * the auth hooks in auth.definition.ts may assign to members.
   * If any of them are missing from WXYCRoles, the requirePermissions
   * middleware will return 403 "Invalid role" for those users.
   */
  it.each(['member', 'dj', 'musicDirector', 'stationManager', 'admin'])('should recognize the "%s" role', (role) => {
    expect(WXYCRoles).toHaveProperty(role);
    expect(WXYCRoles[role as WXYCRole]).toBeDefined();
  });

  describe('role permissions', () => {
    it.each(allRoles)('"%s" should have an authorize function', (role) => {
      const roleDef = WXYCRoles[role];
      expect(typeof (roleDef as any).authorize).toBe('function');
    });

    it.each(allRoles)('"%s" should authorize catalog:read', (role) => {
      const roleDef = WXYCRoles[role];
      const result = (roleDef as any).authorize({ catalog: ['read'] });
      expect(result.success).toBe(true);
    });

    it.each(allRoles)('"%s" should authorize bin:read', (role) => {
      const roleDef = WXYCRoles[role];
      const result = (roleDef as any).authorize({ bin: ['read'] });
      expect(result.success).toBe(true);
    });

    it('admin should authorize catalog:write', () => {
      const result = (WXYCRoles.admin as any).authorize({ catalog: ['write'] });
      expect(result.success).toBe(true);
    });

    it('admin should authorize flowsheet:write', () => {
      const result = (WXYCRoles.admin as any).authorize({ flowsheet: ['write'] });
      expect(result.success).toBe(true);
    });

    it('member should NOT authorize flowsheet:write', () => {
      const result = (WXYCRoles.member as any).authorize({ flowsheet: ['write'] });
      expect(result.success).toBe(false);
    });

    it('member should NOT authorize catalog:write', () => {
      const result = (WXYCRoles.member as any).authorize({ catalog: ['write'] });
      expect(result.success).toBe(false);
    });
  });
});
