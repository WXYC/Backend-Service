/**
 * Unit tests for the better-auth mock-parity comparator.
 *
 * The comparator is the library-drift tripwire for the whole auth unit suite
 * (see `shared/authentication/src/access-mock-parity.ts`), and a tripwire
 * whose failure mode is "passes silently" is worse than none. These tests
 * prove it actually detects the divergences it exists to catch — a changed
 * org-admin statement set and a changed `authorize` verdict — rather than
 * returning an empty finding list unconditionally.
 *
 * The runner (`scripts/check-better-auth-mock-sync.ts`) is deliberately thin
 * because `scripts/**` is neither linted nor typechecked in this repo.
 */
import { describe, it, expect } from '@jest/globals';
import {
  compareAccessModules,
  type AccessModule,
  type OrgAccessModule,
} from '../../../shared/authentication/src/access-mock-parity';
import * as accessMock from '../../mocks/better-auth-access.mock';
import * as orgAccessMock from '../../mocks/better-auth-org-access.mock';

const mockModules = {
  access: accessMock as unknown as AccessModule,
  orgAccess: orgAccessMock as unknown as OrgAccessModule,
};

/** A faithful stand-in for the real modules: the mocks compared against themselves. */
const identical = () => ({
  access: accessMock as unknown as AccessModule,
  orgAccess: orgAccessMock as unknown as OrgAccessModule,
});

describe('compareAccessModules', () => {
  it('reports no findings when the two implementations agree', () => {
    expect(compareAccessModules(identical(), mockModules)).toEqual([]);
  });

  it('detects a changed adminAc statement set (the better-auth upgrade case)', () => {
    const drifted = {
      ...identical(),
      orgAccess: {
        defaultStatements: orgAccessMock.defaultStatements,
        adminAc: {
          statements: {
            ...orgAccessMock.adminAc.statements,
            // A hypothetical new library-owned key + action.
            organization: ['update', 'delete'],
          },
        },
      } as unknown as OrgAccessModule,
    };

    const findings = compareAccessModules(drifted, mockModules);
    expect(findings.some((f) => f.kind === 'statements' && f.detail.includes('adminAc.statements'))).toBe(true);
  });

  it('detects a changed defaultStatements set', () => {
    const drifted = {
      ...identical(),
      orgAccess: {
        defaultStatements: { ...orgAccessMock.defaultStatements, workspace: ['create'] },
        adminAc: orgAccessMock.adminAc,
      } as unknown as OrgAccessModule,
    };

    const findings = compareAccessModules(drifted, mockModules);
    expect(findings.some((f) => f.kind === 'statements' && f.detail.includes('defaultStatements'))).toBe(true);
  });

  it('detects diverging authorize verdicts', () => {
    const permissive: AccessModule = {
      createAccessControl: () => ({
        newRole: () => ({
          authorize: () => ({ success: true }), // says yes to everything
          statements: {},
        }),
      }),
    };

    const findings = compareAccessModules({ ...identical(), access: permissive }, mockModules);
    expect(findings.some((f) => f.kind === 'authorize')).toBe(true);
  });

  it('names the resource and action in an authorize finding', () => {
    const denyAll: AccessModule = {
      createAccessControl: () => ({
        newRole: () => ({
          authorize: () => ({ success: false }),
          statements: {},
        }),
      }),
    };

    const findings = compareAccessModules({ ...identical(), access: denyAll }, mockModules);
    const authorizeFindings = findings.filter((f) => f.kind === 'authorize');
    expect(authorizeFindings.length).toBeGreaterThan(0);
    expect(authorizeFindings[0].detail).toMatch(/\w+:\w+ — real=(true|false) mock=(true|false)/);
  });
});
