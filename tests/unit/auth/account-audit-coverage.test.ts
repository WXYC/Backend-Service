/**
 * Unit tests for apps/auth/audit-coverage.ts (BS#2537, parent epic #2534):
 * the coverage-rule matrix (admin action map + GET includes, flat mounts,
 * explicit call sites, allowlist) and both drift-check arms' compare
 * functions. `scripts/check-audit-route-coverage.ts` is a thin runner over
 * this module and is not itself unit-tested (it is exercised end-to-end via
 * `npm run check:audit-coverage`, which this PR's report documents running
 * locally).
 */
import {
  ADMIN_ACTIONS,
  ADMIN_PREFIX,
  ALLOWLIST,
  FLAT_MOUNTS,
  STATION_SIGNUP_ADMIN_OPS,
  findUncoveredAuthApiEndpoints,
  findUncoveredExpressRoutes,
  isAllowlisted,
  isAudited,
} from '../../../apps/auth/audit-coverage';

describe('admin action map coverage', () => {
  it('treats every known admin action as audited', () => {
    expect(isAudited('/admin/set-role')).toBe(true);
    expect(isAudited('/admin/station-signup/reveal')).toBe(true);
  });

  // Deliberate behavior change (item 4, code review BS#2537 PR #2545): a
  // path under /admin is covered iff it's a KEY in ADMIN_ACTIONS, not
  // merely "starts with /admin" — the bare prefix itself is not a real
  // action, and an unlisted sub-path is not covered by riding through on
  // the old prefix match.
  it('does not treat the bare prefix or an unknown admin path as audited', () => {
    expect(isAudited(ADMIN_PREFIX)).toBe(false);
    expect(isAudited('/admin/not-a-real-action')).toBe(false);
  });
});

describe('ADMIN_ACTIONS (HIGH 1 + M2 + simplify-pass item 2, code review BS#2537 PR #2545)', () => {
  it('names every path with its dotted admin.* action', () => {
    expect(ADMIN_ACTIONS.get('/admin/set-role')?.action).toBe('admin.set-role');
    expect(ADMIN_ACTIONS.get('/admin/station-signup/approve')?.action).toBe('admin.station-signup.approve');
  });

  it('flags exactly the PII-bulk-read GETs with includeGet: true', () => {
    expect(ADMIN_ACTIONS.get('/admin/get-user')?.includeGet).toBe(true);
    expect(ADMIN_ACTIONS.get('/admin/list-users')?.includeGet).toBe(true);
    // Non-GET actions carry no includeGet flag at all (falsy, not `false`).
    expect(ADMIN_ACTIONS.get('/admin/set-role')?.includeGet).toBeUndefined();
  });

  it('has no entry for an unknown path', () => {
    expect(ADMIN_ACTIONS.has('/admin/not-a-real-action')).toBe(false);
  });

  it('derives the six station-signup entries from STATION_SIGNUP_ADMIN_OPS', () => {
    expect(STATION_SIGNUP_ADMIN_OPS).toHaveLength(6);
    for (const op of STATION_SIGNUP_ADMIN_OPS) {
      expect(ADMIN_ACTIONS.get(`/admin/station-signup/${op}`)?.action).toBe(`admin.station-signup.${op}`);
    }
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

  // Item 1 (simplify pass, code review BS#2537 PR #2545 follow-up).
  it('annotates the subject strategy correctly for each category', () => {
    expect(FLAT_MOUNTS.find((m) => m.path === '/request-password-reset')?.subject).toBe('email-lookup');
    for (const path of ['/change-password', '/change-email', '/update-user', '/delete-user']) {
      expect(FLAT_MOUNTS.find((m) => m.path === path)?.subject).toBe('actor');
    }
    for (const mount of FLAT_MOUNTS) {
      if (mount.path === '/request-password-reset' || mount.subject === 'actor') continue;
      expect(mount.subject).toBe('body-user-id');
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

describe('findUncoveredAuthApiEndpoints is method-aware (M3 + simplify-pass item 4, code review BS#2537 PR #2545)', () => {
  it('does not flag a known admin GET that IS includeGet: true', () => {
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
  it('flags an admin-prefix GET that is neither includeGet: true nor allowlisted', () => {
    const endpoints = [{ path: '/admin/some-new-read', methods: ['GET'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual(['/admin/some-new-read']);
  });

  // Deliberate behavior change (item 4): a path under /admin absent from
  // ADMIN_ACTIONS entirely (not just absent from the GET-include flag) now
  // fails the check instead of riding through on a prefix match.
  it('flags a non-GET admin-prefix path that is not a key in ADMIN_ACTIONS at all', () => {
    const endpoints = [{ path: '/admin/some-future-endpoint', methods: ['POST'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual(['/admin/some-future-endpoint']);
  });

  // Drift-verified-by-test (mirrors the allowlist-removal test above): this
  // proves the check WOULD fail on '/admin/get-user' itself if that map
  // entry (or just its includeGet flag) were ever removed, without
  // actually mutating the shared module-level map out from under other
  // tests in this file — the endpoint above already IS the shape
  // '/admin/get-user' would take the moment its entry disappears (GET,
  // admin-prefix, not allowlisted), and this assertion pins that today's
  // real map entry is the only thing standing between the two.
  it('would fail on /admin/get-user today if its map entry were removed', () => {
    expect(ADMIN_ACTIONS.get('/admin/get-user')?.includeGet).toBe(true);
    expect(isAllowlisted('/admin/get-user')).toBe(false);
  });

  // Item 4's second requirement: flat mounts never audit GET.
  it('flags a GET-only endpoint at a flat-mount path unless allowlisted', () => {
    const flatPath = FLAT_MOUNTS[0].path;
    const endpoints = [{ path: flatPath, methods: ['GET'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual([flatPath]);
  });

  it('does not flag a non-GET endpoint at a flat-mount path', () => {
    const flatPath = FLAT_MOUNTS[0].path;
    const endpoints = [{ path: flatPath, methods: ['POST'] }];
    expect(findUncoveredAuthApiEndpoints(endpoints)).toEqual([]);
  });

  // Drift-verified-by-test, same idiom as the admin case above: proves a
  // GET at a real flat-mount path would fail today unless allowlisted.
  it('would fail on a GET at a flat-mount path today unless it were allowlisted', () => {
    const flatPath = FLAT_MOUNTS[0].path;
    expect(isAllowlisted(flatPath)).toBe(false);
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
