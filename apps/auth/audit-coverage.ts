/**
 * Single source of truth for account-audit coverage (BS#2537, parent epic
 * #2534): audited prefix, GET-include exceptions, flat-mount table,
 * explicit-call-site set, and allowlist. `app.ts`'s mounts and
 * `scripts/check-audit-route-coverage.ts`'s two drift-check arms both import
 * from here, so a mount and the check it's measured against can't drift.
 *
 * DEVIATION FROM THE ISSUE TEXT (reported in the PR body): the issue names a
 * flat mount at `/auth/forget-password`. Installed better-auth (^1.6.30) has
 * no such endpoint — the real "forgot password" route is `requestPasswordReset`
 * at `/request-password-reset` (confirmed against the live `auth.api` table;
 * `/auth/forget-password` matches nothing and 404s through the catch-all).
 * `app.ts`'s `rateLimitedPaths` used to rate-limit that same dead string
 * (M1, code review BS#2537 PR #2545) — fixed to the real path in the same
 * change, so decision 11's "mounted ahead of the Express rate limiters"
 * public-mount argument now actually holds for this path, not just the
 * others it was already true for. `forget-password` below mounts on the
 * real path.
 *
 * Every path is BARE (no leading `/auth`) — matching `auth.api` entries'
 * own `.path`, and what a hand-written Express route normalizes to once
 * `/auth` is stripped (arm 2).
 */

/** All 15 better-auth admin-plugin endpoints, `provision-user`, and the six
 * station-signup admin ops live under this prefix — a prefix match, so a
 * future addition under it is covered by construction. */
export const ADMIN_PREFIX = '/admin';

/** GET paths under ADMIN_PREFIX that ARE logged despite being reads — the
 * PII bulk reads named in Scope. `list-user-sessions` is POST in the
 * installed better-auth version (auto-covered by the non-GET rule either
 * way); kept here for a future version that reverts it to GET. */
export const ADMIN_GET_INCLUDES: ReadonlySet<string> = new Set([
  '/admin/get-user',
  '/admin/list-users',
  '/admin/list-user-sessions',
]);

/**
 * The full known admin-prefix action surface, path -> dotted action slug.
 * Code-review finding (BS#2537 PR #2545, HIGH + M2): `adminPrefixAuditMiddleware`
 * used to derive the slug from `req.path` text and log every non-GET
 * request under the prefix regardless of whether the path was a real
 * action. Two live bugs followed — Express 5 strips the mount path, so
 * `req.path` inside the middleware never actually carried the `/admin`
 * segment the slug needed, and any anonymous request to
 * `/auth/admin/<garbage>` cost a getSession read + an INSERT while minting
 * an attacker-controlled action string. Both are fixed by looking the
 * canonical path up in this map instead of transforming request text: an
 * unlisted path is not a known action and is skipped before any work
 * happens (see `adminPrefixAuditMiddleware`), and the slug for a known path
 * can never be attacker-influenced.
 *
 * Every non-GET better-auth admin-plugin endpoint, `provision-user`,
 * `resolve-organization` is a GET-only read excluded here on purpose (GETs
 * are gated separately by `ADMIN_GET_INCLUDES`, and this map exists to gate
 * the non-GET surface + name known GET actions — resolve-organization not
 * being in `ADMIN_GET_INCLUDES` means it was never logged either way), and
 * the six station-signup admin ops (mounted as a nested router at
 * `/admin/station-signup/*`).
 */
export const ADMIN_ACTION_BY_PATH: ReadonlyMap<string, string> = new Map([
  ['/admin/set-role', 'admin.set-role'],
  ['/admin/get-user', 'admin.get-user'],
  // M4 (code review BS#2537 PR #2545): the created user doesn't exist yet
  // at request time, so there is no `userId` in the body to extract — this
  // action's rows always write subject_user_id NULL. The new user's id is
  // only known from the RESPONSE, which the generic body-only extractor
  // never sees. Same follow-up as the organization mounts below.
  ['/admin/create-user', 'admin.create-user'],
  ['/admin/update-user', 'admin.update-user'],
  ['/admin/list-users', 'admin.list-users'],
  ['/admin/list-user-sessions', 'admin.list-user-sessions'],
  ['/admin/unban-user', 'admin.unban-user'],
  ['/admin/ban-user', 'admin.ban-user'],
  ['/admin/impersonate-user', 'admin.impersonate-user'],
  ['/admin/stop-impersonating', 'admin.stop-impersonating'],
  ['/admin/revoke-user-session', 'admin.revoke-user-session'],
  ['/admin/revoke-user-sessions', 'admin.revoke-user-sessions'],
  ['/admin/remove-user', 'admin.remove-user'],
  ['/admin/set-user-password', 'admin.set-user-password'],
  ['/admin/has-permission', 'admin.has-permission'],
  ['/admin/provision-user', 'admin.provision-user'],
  ['/admin/station-signup/reveal', 'admin.station-signup.reveal'],
  ['/admin/station-signup/rotate', 'admin.station-signup.rotate'],
  ['/admin/station-signup/revoke', 'admin.station-signup.revoke'],
  ['/admin/station-signup/clear-cooldown', 'admin.station-signup.clear-cooldown'],
  ['/admin/station-signup/status', 'admin.station-signup.status'],
  ['/admin/station-signup/approve', 'admin.station-signup.approve'],
]);

export interface FlatMount {
  /** Bare better-auth path, e.g. '/reset-password'. */
  path: string;
  /** Path-derived dotted action slug (decision 14). */
  action: string;
  /** False only for the genuinely unauthenticated mounts (no session to resolve). */
  resolveActor: boolean;
}

export const FLAT_MOUNTS: readonly FlatMount[] = [
  // Public (decision 11) — no session exists; mounted ahead of the Express
  // rate limiters in app.ts. device/approve+deny share that pre-limiter
  // position (and rateLimitedPaths) with forget-password/reset-password —
  // per ADR 0008 a real call to them DOES carry a session, but resolving
  // one here would be a pre-limiter DB-read DoS amplifier for garbage
  // traffic, so a real approval's actor is accepted-lost to NULL.
  { path: '/request-password-reset', action: 'forget-password', resolveActor: false },
  { path: '/reset-password', action: 'reset-password', resolveActor: false },
  { path: '/device/approve', action: 'device.approve', resolveActor: false },
  { path: '/device/deny', action: 'device.deny', resolveActor: false },

  // Authenticated self-service — mounted after the rate limiters, ahead of
  // the better-auth catch-all.
  { path: '/change-password', action: 'change-password', resolveActor: true },
  { path: '/change-email', action: 'change-email', resolveActor: true },
  { path: '/update-user', action: 'update-user', resolveActor: true },
  { path: '/delete-user', action: 'delete-user', resolveActor: true },

  // Authenticated organization mutations. KNOWN LIMITATION (M4, code review
  // BS#2537 PR #2545): every one of these bodies carries a target
  // identifier under a DIFFERENT field than `userId` — `invite-member` uses
  // `email`, `remove-member`/`update-member-role` use `memberIdOrEmail`/
  // `memberId`, `accept/cancel/reject-invitation` use `invitationId` — so
  // `extractBodyUserId`'s generic `body.userId` lookup always misses and
  // `subject_user_id` is NULL on every row these mounts write. Deliberately
  // NOT widened to also try those field names: `memberIdOrEmail` can BE an
  // email address, and this column must never carry PII (the same
  // constraint AC#3 enforces for `forget-password`). Resolving a real
  // member/invitation identifier to a `subject_user_id` needs its own
  // lookup (member -> userId, invitation -> invited userId) and is a
  // follow-up, not a drive-by fix here.
  { path: '/organization/create', action: 'organization.create', resolveActor: true },
  { path: '/organization/update', action: 'organization.update', resolveActor: true },
  { path: '/organization/delete', action: 'organization.delete', resolveActor: true },
  { path: '/organization/invite-member', action: 'organization.invite-member', resolveActor: true },
  { path: '/organization/cancel-invitation', action: 'organization.cancel-invitation', resolveActor: true },
  { path: '/organization/accept-invitation', action: 'organization.accept-invitation', resolveActor: true },
  { path: '/organization/reject-invitation', action: 'organization.reject-invitation', resolveActor: true },
  { path: '/organization/remove-member', action: 'organization.remove-member', resolveActor: true },
  { path: '/organization/update-member-role', action: 'organization.update-member-role', resolveActor: true },
  { path: '/organization/leave', action: 'organization.leave', resolveActor: true },
];

/** Hand-written Express routes (bare, `/auth` stripped) audited via an
 * explicit `recordAccountAuditEvent` call inside the handler — a decorator
 * can't reach `POST /auth/wxyc/complete-onboarding`'s internal
 * `auth.api.resetPassword` call, which never crosses an audited HTTP mount. */
export const EXPLICIT_CALL_SITES: ReadonlySet<string> = new Set(['/wxyc/complete-onboarding']);

/**
 * Every skip, named so both drift-check arms treat it as reviewed (Scope +
 * decision 4). Bare paths — better-auth's own `.path` for its entries, and
 * `/auth`-stripped hand-written routes for the arm-2 entries at the bottom.
 */
export const ALLOWLIST: ReadonlySet<string> = new Set([
  // sign-in / sign-up / sign-out, incl. OAuth social sign-in callback and
  // account-linking (dead today — CLAUDE.md: "Email+password auth only").
  '/sign-in/social',
  '/sign-in/email',
  '/sign-in/email-otp',
  '/sign-in/username',
  '/sign-in/anonymous',
  '/sign-up/email',
  '/sign-out',
  '/callback/:id',
  '/delete-anonymous-user',
  '/is-username-available',
  '/link-social',
  '/unlink-account',
  '/get-access-token',

  // OTP send/verify, incl. the OTP-based reset/change variants — not part
  // of Scope's audited surface; the primary password-based flows above are.
  // Ratified as-written by the issue's allowlist bucket ("OTP send/verify"),
  // NOT a dead-code judgment call: the emailOTP plugin IS configured and
  // live in this deployment (M5, code review BS#2537 PR #2545).
  '/email-otp/send-verification-otp',
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  // LIVE, UNAUDITED account-modifying flows (M5): these two actually change
  // the account's email/password via a code instead of a token, exactly
  // like the audited /change-email and /reset-password mounts above, but
  // ship zero account_audit_event rows. Allowlisted per the issue's literal
  // Scope text, not because they're inert — flagged in the PR body as
  // needing an explicit re-decision, not silently accepted.
  '/email-otp/change-email',
  '/email-otp/request-email-change',
  '/email-otp/request-password-reset',
  // LIVE, UNAUDITED (M5) — see the comment on /email-otp/change-email
  // above. This is the OTP-based POST /reset-password equivalent.
  '/email-otp/reset-password',
  '/forget-password/email-otp',

  '/get-session',

  // device/code + device/token (unauthenticated) and the GET claim step.
  '/device/code',
  '/device/token',
  '/device',

  // oauth2 / oidc / JWKS / bearer token issuance.
  '/.well-known/openid-configuration',
  '/oauth2/authorize',
  '/oauth2/consent',
  '/oauth2/token',
  '/oauth2/userinfo',
  '/oauth2/register',
  '/oauth2/client/:id',
  '/oauth2/endsession',
  '/jwks',
  '/token',

  // Self-directed reads/session management — never another account's identity.
  '/list-sessions',
  '/list-accounts',
  '/account-info',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/update-session',
  '/verify-password',
  '/refresh-token',

  // org reads, incl. set-active (selects the caller's own active org — WXYC
  // runs one org today) and read-shaped checks.
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/get-full-organization',
  '/organization/get-invitation',
  '/organization/has-permission',
  '/organization/list',
  '/organization/list-invitations',
  '/organization/list-members',
  '/organization/list-user-invitations',
  '/organization/check-slug',
  '/organization/set-active',

  // better-auth utility / read routes.
  '/ok',
  '/error',
  '/verify-email',
  '/send-verification-email',
  '/reset-password/:token', // validates + redirects; the mutation is POST /reset-password above.
  '/delete-user/callback', // dead: deleteUser.sendDeleteAccountVerification isn't configured, so POST /delete-user deletes immediately.

  // Hand-written Express routes (arm 2), `/auth` stripped.
  '/wxyc/lookup-email', // read
  '/wxyc/station-signup', // has its own station_signup_attempt log
  '/check-request-ban', // read
  '/test/verification-token', // never production-mounted
  '/test/expire-session',
  '/test/confirm-user',
  '/test/reset-incomplete-user',
]);

const isUnderAdminPrefix = (path: string): boolean => path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);

const isFlatMounted = (path: string): boolean => FLAT_MOUNTS.some((mount) => mount.path === path);

/** True when this bare path is covered by SOME audited mechanism (prefix, flat mount, or explicit call site). */
export const isAudited = (path: string): boolean =>
  isUnderAdminPrefix(path) || isFlatMounted(path) || EXPLICIT_CALL_SITES.has(path);

export const isAllowlisted = (path: string): boolean => ALLOWLIST.has(path);

export interface AuthApiEndpoint {
  path: string;
  methods: readonly string[];
}

const isGetOnly = (methods: readonly string[]): boolean =>
  methods.length > 0 && methods.every((method) => method.toUpperCase() === 'GET');

/**
 * Arm 1: every HTTP-reachable better-auth endpoint (`.path` defined —
 * `SERVER_ONLY`/path-less endpoints are never routed by better-call's own
 * router, so excluding them mirrors reality, not a coverage gap) must be
 * audited or allowlisted. Returns the uncovered ones.
 *
 * Method-aware for the admin prefix specifically (M3, code review BS#2537
 * PR #2545): `isAudited`'s prefix check alone treats EVERY path under
 * `/admin` as covered, but the coverage rule (decision 3) is "GETs only
 * from an explicit include list" — a GET under the prefix that is NOT in
 * `ADMIN_GET_INCLUDES` is not actually logged by the mount, so it must
 * clear the allowlist bar like any other unaudited endpoint instead of
 * riding through on the prefix match. Both admin GETs in the installed
 * better-auth version happen to be in the include list today, which is
 * exactly why this stayed green through the mount-path-stripping bug this
 * finding accompanied — nothing exercised the false-negative case.
 */
export const findUncoveredAuthApiEndpoints = (endpoints: readonly AuthApiEndpoint[]): string[] =>
  endpoints
    .filter((endpoint) => {
      const audited =
        isGetOnly(endpoint.methods) && isUnderAdminPrefix(endpoint.path)
          ? ADMIN_GET_INCLUDES.has(endpoint.path)
          : isAudited(endpoint.path);
      return !audited && !isAllowlisted(endpoint.path);
    })
    .map((e) => e.path);

/**
 * Arm 2: every hand-written non-GET/OPTIONS/HEAD `/auth/...` Express route
 * registration (bare paths, `/auth` already stripped by the caller) must be
 * audited or allowlisted.
 */
export const findUncoveredExpressRoutes = (barePaths: readonly string[]): string[] =>
  barePaths.filter((path) => !isAudited(path) && !isAllowlisted(path));
