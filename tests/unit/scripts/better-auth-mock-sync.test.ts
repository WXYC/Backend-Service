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
    expect(authorizeFindings[0].detail).toMatch(
      /\w+:\w+ \[connector=(<default>|\S+)\] — real=(true|false) mock=(true|false)/
    );
  });

  /**
   * Regression pin for the request surface the comparator sends.
   *
   * better-auth's `authorize(request, connector = 'AND')` accepts a
   * per-resource `{ actions, connector }` object as well as a bare list, and a
   * connector of `'OR'` — at either level — turns `every` into `some`. A
   * comparator that only ever sends single-resource array-form requests at the
   * default connector cannot see a mock that ignores all of that, and a unit
   * test asserting a 403 would then pass while production returned 200.
   *
   * `connectorBlind` below is exactly that mock: array-form only, both
   * connectors ignored, AND semantics always. It is what this file's own
   * subject looked like before, and the point of the test is that parity now
   * rejects it.
   */
  describe('connector and object-form coverage', () => {
    const connectorBlind: AccessModule = {
      createAccessControl: () => ({
        newRole: (permissions) => ({
          authorize: (request) => {
            const entries = Object.entries(request);
            if (entries.length === 0) return { success: false };
            for (const [resource, requested] of entries) {
              const actions = Array.isArray(requested) ? requested : (requested?.actions ?? []);
              if (actions.length === 0) return { success: false };
              const allowed = permissions[resource];
              if (!allowed) return { success: false };
              for (const action of actions) {
                if (!allowed.includes(action)) return { success: false };
              }
            }
            return { success: true };
          },
          statements: permissions,
        }),
      }),
    };

    it('detects a mock that ignores the connector and the object request form', () => {
      const findings = compareAccessModules(identical(), { ...mockModules, access: connectorBlind });
      expect(findings.some((f) => f.kind === 'authorize')).toBe(true);
    });

    it('attributes the divergence to an OR-connector shape, not only to the array form', () => {
      const findings = compareAccessModules(identical(), { ...mockModules, access: connectorBlind });
      expect(findings.some((f) => f.kind === 'authorize' && f.detail.includes('OR'))).toBe(true);
    });

    it('exercises the object request form without throwing', () => {
      // A mock that understands only the array form throws
      // `actions is not iterable` on `{ actions }`. Reaching a finding list at
      // all — rather than an exception — is the assertion here.
      expect(() => compareAccessModules(identical(), mockModules)).not.toThrow();
      expect(compareAccessModules(identical(), mockModules)).toEqual([]);
    });
  });
});
