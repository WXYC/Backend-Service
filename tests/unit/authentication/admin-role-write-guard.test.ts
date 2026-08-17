import { describe, it, expect } from '@jest/globals';

// better-auth/api is stubbed at the jest.unit.config.ts moduleNameMapper
// level (better-auth-api.mock.ts) — the real subpath ships ESM ts-jest
// can't transform. Same pattern as device-authorization.test.ts.

import {
  GUARDED_ROLE_WRITE_PATHS,
  assertScalarRoleWrite,
} from '../../../shared/authentication/src/admin-role-write-guard';

describe('assertScalarRoleWrite', () => {
  it('guards exactly the three admin role-write paths', () => {
    expect([...GUARDED_ROLE_WRITE_PATHS].sort()).toEqual([
      '/admin/create-user',
      '/admin/set-role',
      '/admin/update-user',
    ]);
  });

  describe.each(GUARDED_ROLE_WRITE_PATHS)('on %s', (path) => {
    it('rejects an array-valued role', () => {
      expect(() => assertScalarRoleWrite(path, { role: ['admin', 'user'] })).toThrow(
        expect.objectContaining({ statusCode: 400 })
      );
    });

    it('rejects a single-element array — it still joins to a scalar, but the caller is using the multi-role API', () => {
      expect(() => assertScalarRoleWrite(path, { role: ['admin'] })).toThrow(
        expect.objectContaining({ statusCode: 400 })
      );
    });

    it('rejects a comma-bearing string role', () => {
      expect(() => assertScalarRoleWrite(path, { role: 'admin,user' })).toThrow(
        expect.objectContaining({ statusCode: 400 })
      );
    });

    it.each(['admin', 'user'])('lets the scalar %s through', (role) => {
      expect(() => assertScalarRoleWrite(path, { role })).not.toThrow();
    });

    it('lets a body with no role through — /admin/create-user and /admin/update-user both allow omitting it', () => {
      expect(() => assertScalarRoleWrite(path, {})).not.toThrow();
      expect(() => assertScalarRoleWrite(path, { role: undefined })).not.toThrow();
    });

    it("lets an unknown scalar role through — the plugin's own `roles` allowlist owns that 400, not this guard", () => {
      // Narrowing the alphabet here would duplicate the plugin's validation
      // and drift from it on upgrade. This guard owns exactly one property:
      // that whatever reaches `parseRoles` cannot become a comma list.
      expect(() => assertScalarRoleWrite(path, { role: 'musicDirector' })).not.toThrow();
    });
  });

  it('ignores unrelated paths entirely', () => {
    expect(() => assertScalarRoleWrite('/device/approve', { role: ['admin', 'user'] })).not.toThrow();
    expect(() => assertScalarRoleWrite('/sign-in/email', { role: 'admin,user' })).not.toThrow();
  });

  it('reports the offending path and value in the error body', () => {
    let caught: unknown;
    try {
      assertScalarRoleWrite('/admin/set-role', { role: ['admin', 'user'] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      body: { code: 'ROLE_MUST_BE_SCALAR' },
    });
  });

  it('rejects a non-string, non-array role rather than passing it to parseRoles', () => {
    // `parseRoles` returns a non-array value verbatim, so an object or number
    // would reach the adapter untouched and land in the column as-is.
    expect(() => assertScalarRoleWrite('/admin/set-role', { role: 42 })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
    expect(() => assertScalarRoleWrite('/admin/set-role', { role: { admin: true } })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('tolerates a null or undefined body', () => {
    expect(() => assertScalarRoleWrite('/admin/set-role', undefined)).not.toThrow();
    expect(() => assertScalarRoleWrite('/admin/set-role', null)).not.toThrow();
  });
});
