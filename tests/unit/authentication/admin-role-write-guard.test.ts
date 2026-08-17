import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from '@jest/globals';

// better-auth/api is stubbed at the jest.unit.config.ts moduleNameMapper
// level (better-auth-api.mock.ts) — the real subpath ships ESM ts-jest
// can't transform. Same pattern as device-authorization.test.ts.

import {
  GUARDED_ROLE_WRITE_PATHS,
  assertScalarRoleWrite,
} from '../../../shared/authentication/src/admin-role-write-guard';

/**
 * Derive the routes that can write `auth_user.role` from better-auth's own
 * dist rather than restating the allowlist — asserting the constant equals a
 * copy of itself would only detect edits to the constant, and the risk here
 * is the opposite one: an upstream release adding a fourth role-writing route
 * that silently falls outside the guard.
 *
 * Every role write funnels through `parseRoles` (the comma-join), so its call
 * sites are the complete set. Same source-scan technique as
 * `oidc-provider-public-client-jwt.test.ts`.
 */
const routesThatWriteRole = (): string[] => {
  const routesPath = path.resolve(__dirname, '../../../node_modules/better-auth/dist/plugins/admin/routes.mjs');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const lines = fs.readFileSync(routesPath, 'utf-8').split('\n');

  const found = new Set<string>();
  let currentRoute: string | null = null;
  for (const line of lines) {
    const route = line.match(/createAuthEndpoint\("([^"]+)"/);
    if (route) currentRoute = route[1];
    // Skip `function parseRoles(` — the definition, not a call site.
    if (/[^n] parseRoles\(|=\s*parseRoles\(|:\s*parseRoles\(/.test(line) && currentRoute) {
      found.add(currentRoute);
    }
  }
  return [...found].sort();
};

describe('GUARDED_ROLE_WRITE_PATHS', () => {
  it('covers every better-auth route that reaches parseRoles', () => {
    const upstream = routesThatWriteRole();

    // Sanity-check the scan itself: if the dist layout changes so that nothing
    // matches, an empty set would make the assertion below vacuously true.
    expect(upstream.length).toBeGreaterThan(0);
    expect([...GUARDED_ROLE_WRITE_PATHS].sort()).toEqual(upstream);
  });
});

describe('assertScalarRoleWrite', () => {
  const rejected: Array<[string, unknown]> = [
    ['an array of two roles — passes the plugin allowlist element-wise, then joins', ['admin', 'user']],
    ['a single-element array — joins to a scalar, but uses the multi-role API', ['admin']],
    ['a comma-bearing string', 'admin,user'],
    ['a number, which parseRoles returns verbatim', 42],
    ['an object, which parseRoles returns verbatim', { admin: true }],
  ];

  const accepted: Array<[string, unknown]> = [
    ['the scalar admin', 'admin'],
    ['the scalar user', 'user'],
    // The plugin's own pinned `roles` allowlist owns unknown-value rejection.
    // Duplicating the alphabet here would drift from it on upgrade; this guard
    // owns exactly one property — that nothing reaching parseRoles can join.
    ['an unknown scalar role', 'musicDirector'],
    ['an omitted role, which create-user and update-user both allow', undefined],
  ];

  describe.each(GUARDED_ROLE_WRITE_PATHS)('on %s', (guardedPath) => {
    it.each(rejected)('rejects %s', (_label, role) => {
      expect(() => assertScalarRoleWrite(guardedPath, { role })).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it.each(accepted)('accepts %s', (_label, role) => {
      expect(() => assertScalarRoleWrite(guardedPath, { role })).not.toThrow();
    });
  });

  it('reports a machine-readable code so the caller can distinguish this rejection', () => {
    expect(() => assertScalarRoleWrite('/admin/set-role', { role: ['admin', 'user'] })).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: 'ROLE_MUST_BE_SCALAR' }) })
    );
  });

  it('ignores paths outside the allowlist', () => {
    expect(() => assertScalarRoleWrite('/device/approve', { role: ['admin', 'user'] })).not.toThrow();
    expect(() => assertScalarRoleWrite('/sign-in/email', { role: 'admin,user' })).not.toThrow();
  });

  it('tolerates a missing body', () => {
    expect(() => assertScalarRoleWrite('/admin/set-role', undefined)).not.toThrow();
    expect(() => assertScalarRoleWrite('/admin/set-role', null)).not.toThrow();
    expect(() => assertScalarRoleWrite('/admin/set-role', {})).not.toThrow();
  });
});
