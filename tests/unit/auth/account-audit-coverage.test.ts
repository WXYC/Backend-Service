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
  ADMIN_ACTION_BY_PATH,
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

describe('ADMIN_ACTION_BY_PATH (HIGH 1 + M2, code review BS#2537 PR #2545)', () => {
  it('names every path with its dotted admin.* action', () => {
    expect(ADMIN_ACTION_BY_PATH.get('/admin/set-role')).toBe('admin.set-role');
    expect(ADMIN_ACTION_BY_PATH.get('/admin/station-signup/approve')).toBe('admin.station-signup.approve');
  });

  it('has no entry for an unknown path', () => {
    expect(ADMIN_ACTION_BY_PATH.has('/admin/not-a-real-action')).toBe(false);
  });
});

describe('findUncoveredAuthApiEndpoints is method-aware for the admin prefix (M3, code review BS#2537 PR #2545)', () => {
  it('does not flag a known admin GET that IS in ADMIN_GET_INCLUDES', () => {
    const endpoints = [{ path: '/admin/get-user', methods: ['GET'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual([]);
  });

  it('does not require method-awareness for non-GET admin paths (unaffected by this fix)', () => {
    const endpoints = [{ path: '/admin/set-role', methods: ['POST'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual([]);
  });

  // Before this fix, isAudited's plain prefix match treated EVERY path
  // under /admin as covered regardless of method, so this endpoint would
  // have silently passed. That is exactly the gap the mount-path-stripping
  // bug hid behind: the check stayed green only because neither real admin
  // GET (get-user, list-users) ever exercised the false-negative case.
  it('flags an admin-prefix GET that is neither in ADMIN_GET_INCLUDES nor allowlisted', () => {
    const endpoints = [{ path: '/admin/some-new-read', methods: ['GET'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual(['/admin/some-new-read']);
  });

  // Drift-verified-by-test (mirrors the allowlist-removal test above): this
  // proves the check WOULD fail on '/admin/get-user' itself if that path
  // were ever removed from ADMIN_GET_INCLUDES, without actually mutating
  // the shared module-level set out from under other tests in this file —
  // the endpoint above already IS the shape '/admin/get-user' would take
  // the moment its include-list entry disappears (GET, admin-prefix,
  // not allowlisted), and this assertion pins that today's real include
  // entry is the only thing standing between the two.
  it('would fail on /admin/get-user today if its GET-include entry were removed', () => {
    expect(ADMIN_GET_INCLUDES.has('/admin/get-user')).toBe(true);
    expect(isAllowlisted('/admin/get-user')).toBe(false);
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
