/**
 * Unit tests for apps/auth/audit-coverage.ts (BS#2537, parent epic #2534):
 * the coverage-rule matrix (admin action map + GET includes, flat mounts,
 * explicit call sites, allowlist) and all three drift-check arms' compare
 * functions (arm 3, `findDeclaredMountsMissingFromAuthApi`, added M4, code
 * review BS#2547). `scripts/check-audit-route-coverage.ts` is a thin runner
 * over this module and is not itself unit-tested (it is exercised
 * end-to-end via `npm run check:audit-coverage`, which this PR's report
 * documents running locally, including a manual bogus-path verification of
 * arm 3).
 */
import type { AuthApiEndpoint } from '../../../apps/auth/audit-coverage';
import {
  ADMIN_ACTIONS,
  ADMIN_PREFIX,
  ALLOWLIST,
  FLAT_MOUNTS,
  STATION_SIGNUP_ADMIN_OPS,
  classifyFlatMountAction,
  findDeclaredMountsMissingFromAuthApi,
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

  // Item 1 (simplify pass, code review BS#2537 PR #2545 follow-up); extended
  // by BS#2553 for the two new 'response-user-id' mounts and
  // /organization/invite-member's move to 'email-lookup'.
  it('annotates the subject strategy correctly for each category', () => {
    const emailLookupPaths = [
      '/request-password-reset',
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/forget-password/email-otp',
      '/email-otp/send-verification-otp',
      '/organization/invite-member',
    ];
    for (const path of emailLookupPaths) {
      expect(FLAT_MOUNTS.find((m) => m.path === path)?.subject).toBe('email-lookup');
    }
    for (const path of ['/change-password', '/change-email', '/update-user', '/delete-user']) {
      expect(FLAT_MOUNTS.find((m) => m.path === path)?.subject).toBe('actor');
    }
    const responseUserIdPaths = ['/organization/remove-member', '/organization/update-member-role'];
    for (const path of responseUserIdPaths) {
      expect(FLAT_MOUNTS.find((m) => m.path === path)?.subject).toBe('response-user-id');
    }
    for (const mount of FLAT_MOUNTS) {
      if (
        emailLookupPaths.includes(mount.path) ||
        mount.subject === 'actor' ||
        responseUserIdPaths.includes(mount.path)
      )
        continue;
      expect(mount.subject).toBe('body-user-id');
    }
  });

  // BS#2547 (M5 re-decision, parent epic #2534); extended by BS#2551
  // (Option A) to five, and by BS#2553's invite-member move to six. The
  // tally is the cheapest possible drift check for "did every email-lookup
  // mount actually land with the right strategy" — counting the whole set is
  // stronger than counting the known paths above (which would report green
  // even if a stray email-lookup mount appeared and a real one among them
  // regressed to a different strategy by coincidence).
  it('carries exactly six email-lookup mounts (1 token flow + 3 OTP arms + 1 discriminated send-verification-otp + invite-member, BS#2547/BS#2551/BS#2553)', () => {
    const emailLookupMounts = FLAT_MOUNTS.filter((m) => m.subject === 'email-lookup');
    expect(emailLookupMounts).toHaveLength(6);
    expect(emailLookupMounts.map((m) => m.path).sort()).toEqual(
      [
        '/request-password-reset',
        '/email-otp/request-password-reset',
        '/email-otp/reset-password',
        '/forget-password/email-otp',
        '/email-otp/send-verification-otp',
        '/organization/invite-member',
      ].sort()
    );
  });

  // BS#2553: the two mounts whose subject is resolved from the operation's
  // own 2xx response body, and the responsePath each declares — pinned so a
  // future refactor of either better-auth response shape (or a copy-paste
  // path typo) fails loudly here instead of silently nulling subject_user_id
  // in production.
  it('declares the correct responsePath for each response-user-id mount', () => {
    expect(FLAT_MOUNTS.find((m) => m.path === '/organization/remove-member')?.responsePath).toEqual([
      'member',
      'userId',
    ]);
    expect(FLAT_MOUNTS.find((m) => m.path === '/organization/update-member-role')?.responsePath).toEqual(['userId']);
    expect(ADMIN_ACTIONS.get('/admin/create-user')?.subject).toBe('response-user-id');
    expect(ADMIN_ACTIONS.get('/admin/create-user')?.responsePath).toEqual(['user', 'id']);
  });

  it('mounts the three OTP password-reset arms public (resolveActor: false), per BS#2547', () => {
    const otpPaths = ['/email-otp/request-password-reset', '/email-otp/reset-password', '/forget-password/email-otp'];
    for (const path of otpPaths) {
      expect(FLAT_MOUNTS.find((m) => m.path === path)?.resolveActor).toBe(false);
    }
  });

  it('gives the three OTP password-reset arms path-derived dotted slugs distinct from the token flow (decision 14)', () => {
    expect(FLAT_MOUNTS.find((m) => m.path === '/email-otp/request-password-reset')?.action).toBe(
      'email-otp.request-password-reset'
    );
    expect(FLAT_MOUNTS.find((m) => m.path === '/email-otp/reset-password')?.action).toBe('email-otp.reset-password');
    expect(FLAT_MOUNTS.find((m) => m.path === '/forget-password/email-otp')?.action).toBe('forget-password.email-otp');
  });
});

describe('body-discriminated FlatMount (BS#2551, Option A)', () => {
  const sendVerificationOtpMount = FLAT_MOUNTS.find((m) => m.path === '/email-otp/send-verification-otp');

  it('declares /email-otp/send-verification-otp as a discriminated mount, not a static one', () => {
    expect(sendVerificationOtpMount).toBeDefined();
    expect(sendVerificationOtpMount?.action).toBeUndefined();
    expect(sendVerificationOtpMount?.discriminator).toEqual({
      field: 'type',
      actions: { 'forget-password': 'email-otp.send-verification-otp.forget-password' },
      fallbackAction: 'email-otp.send-verification-otp.type-absent',
    });
    expect(sendVerificationOtpMount?.resolveActor).toBe(false);
    expect(sendVerificationOtpMount?.subject).toBe('email-lookup');
  });

  it('classifies type: forget-password to the discriminated action slug', () => {
    expect(classifyFlatMountAction(sendVerificationOtpMount, { type: 'forget-password' })).toBe(
      'email-otp.send-verification-otp.forget-password'
    );
  });

  it.each(['sign-in', 'email-verification', 'change-email'])('classifies type: %s to null (not audited)', (type) => {
    expect(classifyFlatMountAction(sendVerificationOtpMount, { type })).toBeNull();
  });

  it.each([undefined, null, 42, {}])(
    'classifies a present-but-non-string type (%p) to null (field present, value unmapped)',
    (type) => {
      expect(classifyFlatMountAction(sendVerificationOtpMount, { type })).toBeNull();
    }
  );

  // M1 (code review PR #2557, adjudicated VALID end-to-end): a bare
  // `actions[value]` index resolves an inherited Object.prototype member
  // for these keys — a Function or the prototype object itself, both
  // truthy and neither `undefined` — so a guard on the INPUT value's type
  // alone never catches them. Every one of these must classify to null
  // (zero rows), the same as any other unmapped `type`. Adjudicator
  // reproduced `type: 'constructor'` writing `action =
  // 'function Object() { [native code] }'` and `'__proto__'` writing
  // `'[object Object]'` before this fix; this is the regression test.
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'classifies an inherited Object.prototype key (type: %s) to null, never resolving the prototype member',
    (type) => {
      expect(classifyFlatMountAction(sendVerificationOtpMount, { type })).toBeNull();
    }
  );

  // H1 (code review PR #2557, adjudicated VALID end-to-end): reversed from
  // "classifies to null" — a body that never carries a `type` key at all
  // (never parsed, e.g. content-type spoofing past express.json() while
  // better-call's own broader parser still processes the request for
  // real — see BodyDiscriminator's doc comment; root cause BS#2558) must
  // NOT go silent the way a present-but-unmapped `type` does. Fails closed
  // to `fallbackAction` so a row still lands.
  it('fails closed to fallbackAction when the body has no type field at all', () => {
    expect(classifyFlatMountAction(sendVerificationOtpMount, {})).toBe('email-otp.send-verification-otp.type-absent');
  });

  it.each([undefined, null, 'not-an-object', 42, ['array']])(
    'fails closed to fallbackAction when the body itself is unusable (%p)',
    (body) => {
      expect(classifyFlatMountAction(sendVerificationOtpMount, body)).toBe(
        'email-otp.send-verification-otp.type-absent'
      );
    }
  );

  it('leaves a static mount unaffected by classifyFlatMountAction (ignores body entirely)', () => {
    const forgetPassword = FLAT_MOUNTS.find((m) => m.action === 'forget-password');
    expect(classifyFlatMountAction(forgetPassword, { anything: 'goes' })).toBe('forget-password');
    expect(classifyFlatMountAction(forgetPassword, undefined)).toBe('forget-password');
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
  // Restored (MEDIUM 2, code review BS#2537 PR #2545, second round): this
  // block and its two siblings above it were dropped when the simplify pass
  // replaced this describe block with the method-aware one below -- the
  // map-based API refactor doesn't change any of these three assertions'
  // behavior, so they're recreated verbatim.
  it('flags a currently-allowlisted path once it is no longer in the allowlist', () => {
    expect(isAllowlisted('/get-session')).toBe(true);
    const withoutAllowlistEntry = (path: string): boolean => path !== '/get-session' && isAllowlisted(path);
    expect(isAudited('/get-session') || withoutAllowlistEntry('/get-session')).toBe(false);
  });

  // BS#2551 (Option A): the same drift-verified-by-test idiom as above,
  // applied to the NEW discriminated mount. Before this ticket,
  // '/email-otp/send-verification-otp' was allowlisted, so removing its
  // classification meant removing an ALLOWLIST entry (the case above).
  // After this ticket it's the reverse: the path's ONLY coverage is its
  // FLAT_MOUNTS row (confirmed here: not an ADMIN_ACTIONS key, not
  // allowlisted), so a future edit that deletes that row WITHOUT
  // re-allowlisting the path leaves nothing standing between it and arm
  // 1's uncovered-endpoint report — the same shape as the generic
  // '/a-brand-new-mutation' case two tests up.
  it('would fail arm 1 if the FLAT_MOUNTS entry for /email-otp/send-verification-otp were removed without re-allowlisting it', () => {
    const path = '/email-otp/send-verification-otp';
    expect(ADMIN_ACTIONS.has(path)).toBe(false);
    expect(isAllowlisted(path)).toBe(false);
    // Covered TODAY, solely via its FLAT_MOUNTS row (non-GET, so the
    // method-aware admin/flat-mount split above doesn't apply here).
    expect(findUncoveredAuthApiEndpoints([{ path, methods: ['POST'] }])).toEqual([]);
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

  // Drift-verified-by-test (mirrors the generic allowlist-removal case in
  // the 'findUncoveredAuthApiEndpoints — arm 1' describe block above): this
  // proves the check WOULD fail on '/admin/get-user' itself if that map
  // entry (or just its includeGet flag) were ever removed, without
  // actually mutating the shared module-level map out from under other
  // tests in this file — the endpoint two tests up already IS the shape
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

  // Drift-verified-by-test, same idiom as the ADMIN_ACTIONS-removal case
  // immediately above in this same describe block: proves a GET at a real
  // flat-mount path would fail today unless allowlisted.
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

describe('findDeclaredMountsMissingFromAuthApi — arm 3 (M4, code review BS#2547)', () => {
  // Every FLAT_MOUNTS path, plus every ADMIN_ACTIONS path that ISN'T a
  // hand-written entry (provision-user, station-signup) — a synthetic
  // "everything declared is reachable" endpoint set. Built from the tables
  // themselves rather than hardcoded so this test doesn't need updating
  // every time a mount is added.
  const fullyReachableEndpoints = (): AuthApiEndpoint[] => [
    ...FLAT_MOUNTS.map((mount) => ({ path: mount.path, methods: ['POST'] })),
    ...[...ADMIN_ACTIONS.entries()]
      .filter(([, action]) => action.handWritten !== true)
      .map(([path]) => ({ path, methods: ['POST'] })),
  ];

  it('reports nothing missing when every declared mount is reachable', () => {
    expect(findDeclaredMountsMissingFromAuthApi(fullyReachableEndpoints())).toEqual([]);
  });

  // The regression this arm exists for: better-auth marking an endpoint
  // `@deprecated` today and removing it in a future major. Simulated here
  // by dropping one FLAT_MOUNTS path out of the reachable set.
  it('flags a FLAT_MOUNTS path no longer present in auth.api', () => {
    const missingPath = FLAT_MOUNTS[0].path;
    const endpoints = fullyReachableEndpoints().filter((e) => e.path !== missingPath);
    expect(findDeclaredMountsMissingFromAuthApi(endpoints)).toContain(missingPath);
  });

  it('flags a real ADMIN_ACTIONS path no longer present in auth.api', () => {
    const endpoints = fullyReachableEndpoints().filter((e) => e.path !== '/admin/set-role');
    expect(findDeclaredMountsMissingFromAuthApi(endpoints)).toContain('/admin/set-role');
  });

  // The false-positive this arm must NOT produce: provision-user and the
  // six station-signup ops are hand-written Express routes that were never
  // in auth.api to begin with (manually verified while building this arm —
  // `/admin/provision-user` failed immediately before the `handWritten`
  // flag was added). Even with NOTHING reachable, neither should be
  // reported.
  it('never flags provision-user or a station-signup op, even when nothing is reachable (handWritten exclusion)', () => {
    const missing = findDeclaredMountsMissingFromAuthApi([]);
    expect(missing).not.toContain('/admin/provision-user');
    for (const op of STATION_SIGNUP_ADMIN_OPS) {
      expect(missing).not.toContain(`${ADMIN_PREFIX}/station-signup/${op}`);
    }
  });
});
