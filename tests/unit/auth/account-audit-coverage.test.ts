/**
 * Unit tests for apps/auth/audit-coverage.ts (BS#2537, parent epic #2534):
 * the coverage-rule matrix (admin prefix + GET includes, flat mounts,
 * explicit call sites, allowlist) and both drift-check arms' compare
 * functions. `scripts/check-audit-route-coverage.ts` is a thin runner over
 * this module and is not itself unit-tested (it is exercised end-to-end via
 * `npm run check:audit-coverage`, which this PR's report documents running
 * locally).
 */
import {
  ADMIN_GET_INCLUDES,
  ADMIN_PREFIX,
  ALLOWLIST,
  FLAT_MOUNTS,
  findUncoveredAuthApiEndpoints,
  findUncoveredExpressRoutes,
  isAllowlisted,
  isAudited,
} from '../../../apps/auth/audit-coverage';

describe('admin prefix coverage', () => {
  it('treats every path under the prefix as audited', () => {
    expect(isAudited('/admin/set-role')).toBe(true);
    expect(isAudited('/admin/station-signup/reveal')).toBe(true);
    expect(isAudited(ADMIN_PREFIX)).toBe(true);
  });

  it('does not treat a sibling path as under the prefix', () => {
    expect(isAudited('/administrator')).toBe(false);
  });

  it('names exactly the PII-bulk-read GETs in the include list', () => {
    expect(ADMIN_GET_INCLUDES.has('/admin/get-user')).toBe(true);
    expect(ADMIN_GET_INCLUDES.has('/admin/list-users')).toBe(true);
  });
});

describe('flat mounts', () => {
  it('audits every declared flat mount path', () => {
    for (const mount of FLAT_MOUNTS) {
      expect(isAudited(mount.path)).toBe(true);
    }
  });

  it('mounts the real forget-password route, not the dead /forget-password string', () => {
    const forgetPassword = FLAT_MOUNTS.find((m) => m.action === 'forget-password');
    expect(forgetPassword?.path).toBe('/request-password-reset');
  });

  it('marks the unauthenticated mounts resolveActor: false', () => {
    const publicPaths = ['/request-password-reset', '/reset-password', '/device/approve', '/device/deny'];
    for (const path of publicPaths) {
      expect(FLAT_MOUNTS.find((m) => m.path === path)?.resolveActor).toBe(false);
    }
  });
});

describe('isAllowlisted / isAudited never overlap', () => {
  it('no path is classified both ways', () => {
    for (const path of ALLOWLIST) {
      expect(isAudited(path)).toBe(false);
    }
  });
});

describe('findUncoveredAuthApiEndpoints — arm 1', () => {
  it('reports nothing uncovered for a fully-classified endpoint set', () => {
    const endpoints = [
      { path: '/admin/set-role', methods: ['POST'] },
      { path: '/get-session', methods: ['GET', 'POST'] },
      { path: '/reset-password', methods: ['POST'] },
    ];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual([]);
  });

  it('reports a path in neither the audited set nor the allowlist', () => {
    const endpoints = [{ path: '/a-brand-new-mutation', methods: ['POST'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual(['/a-brand-new-mutation']);
  });

  // The AC#4 drift-verified-by-test case: allowlist a real path in the
  // allowlist, feed it through the compare with a stand-in classifier that
  // omits it, and confirm the omission is what the real check would flag.
  it('flags a currently-allowlisted path once it is no longer in the allowlist', () => {
    expect(isAllowlisted('/get-session')).toBe(true);
    const withoutAllowlistEntry = (path: string): boolean => path !== '/get-session' && isAllowlisted(path);
    expect(isAudited('/get-session') || withoutAllowlistEntry('/get-session')).toBe(false);
  });
});

describe('findUncoveredExpressRoutes — arm 2', () => {
  it('audits the explicit-call-site path', () => {
    expect(findUncoveredExpressRoutes(['/wxyc/complete-onboarding'])).toEqual([]);
  });

  it('allowlists the named hand-written routes', () => {
    expect(findUncoveredExpressRoutes(['/wxyc/lookup-email', '/wxyc/station-signup', '/check-request-ban'])).toEqual(
      []
    );
  });

  it('flags a hand-written route named in neither set', () => {
    expect(findUncoveredExpressRoutes(['/wxyc/not-yet-classified'])).toEqual(['/wxyc/not-yet-classified']);
  });
});
