import { WXYCRoles, normalizeRole, type WXYCRole } from '../../../shared/authentication/src/auth.roles';

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
