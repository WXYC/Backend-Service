/**
 * Single source of truth for account-audit coverage (BS#2537, parent epic
 * #2534): admin action map, flat-mount table, explicit-call-site set, and
 * allowlist. `app.ts`'s mounts and `scripts/check-audit-route-coverage.ts`'s
 * two drift-check arms both import from here, so a mount and the check it's
 * measured against can't drift.
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

export const ADMIN_PREFIX = '/admin';

export interface AdminAction {
  action: string;
  /** True only for the PII-bulk-read GETs (decision 3's explicit include list). Omitted (falsy) for every mutation. */
  includeGet?: true;
}

const STATION_SIGNUP_ADMIN_PREFIX = `${ADMIN_PREFIX}/station-signup`;

/**
 * The six station-signup admin op names, exactly as passed to
 * `stationSignupAdminRoute('<op>', ...)` in `app.ts`. Exported so
 * `tests/unit/auth/account-audit-coverage.test.ts` can assert two-way
 * source-text parity against `app.ts` (simplify pass, code review BS#2537
 * PR #2545) — this closes the drift-check blind spot the previously
 * hand-listed six `ADMIN_ACTIONS` entries were: nothing caught `app.ts`
 * growing a seventh op this file forgot to list.
 */
export const STATION_SIGNUP_ADMIN_OPS = ['reveal', 'rotate', 'revoke', 'clear-cooldown', 'status', 'approve'] as const;

/**
 * The full known admin-prefix action surface, path -> { action, includeGet }.
 * Simplify pass (code review BS#2537 PR #2545 follow-up): this used to be a
 * path->slug Map plus a separate `ADMIN_GET_INCLUDES` Set, kept in sync by
 * hand — one map removes that seam and the two GET entries just carry
 * `includeGet: true` inline.
 *
 * This map is ALSO the coverage check's source of truth for "is this path a
 * known admin action" (item 4 of the simplify pass): a path under `/admin`
 * is covered iff it is a key here — mirroring the runtime `isKnown` gate in
 * `account-audit-middleware.ts` exactly. That is a DELIBERATE behavior
 * change to the CHECK relative to the earlier plain-prefix-match version: a
 * future better-auth `/admin` endpoint absent from this map now FAILS
 * `check:audit-coverage` instead of being silently assumed covered. That is
 * the check doing its job — a map miss means nobody has looked at the new
 * endpoint and decided whether it needs auditing yet, and the map (not a
 * blanket prefix rule) is what makes that decision visible in a diff.
 *
 * Covers every non-GET better-auth admin-plugin endpoint, `provision-user`
 * (`resolve-organization` is GET-only and not in this map — GETs are gated
 * by `includeGet`, and resolve-organization isn't one of the two PII bulk
 * reads, so it was never logged either way), and the six station-signup
 * admin ops (mounted as a nested router at `/admin/station-signup/*`),
 * derived from `STATION_SIGNUP_ADMIN_OPS` rather than hand-listed.
 */
export const ADMIN_ACTIONS: ReadonlyMap<string, AdminAction> = new Map([
  ['/admin/set-role', { action: 'admin.set-role' }],
  ['/admin/get-user', { action: 'admin.get-user', includeGet: true }],
  // M4 (code review BS#2537 PR #2545): the created user doesn't exist yet
  // at request time, so there is no `userId` in the body to extract — this
  // action's rows always write subject_user_id NULL. The new user's id is
  // only known from the RESPONSE, which the generic body-only extractor
  // never sees. Same follow-up as the organization mounts below.
  ['/admin/create-user', { action: 'admin.create-user' }],
  ['/admin/update-user', { action: 'admin.update-user' }],
  ['/admin/list-users', { action: 'admin.list-users', includeGet: true }],
  // `list-user-sessions` is POST in the installed better-auth version
  // (auto-covered by the non-GET rule either way); `includeGet` is set
  // here too, for a future version that reverts it to GET.
  ['/admin/list-user-sessions', { action: 'admin.list-user-sessions', includeGet: true }],
  ['/admin/unban-user', { action: 'admin.unban-user' }],
  ['/admin/ban-user', { action: 'admin.ban-user' }],
  ['/admin/impersonate-user', { action: 'admin.impersonate-user' }],
  ['/admin/stop-impersonating', { action: 'admin.stop-impersonating' }],
  ['/admin/revoke-user-session', { action: 'admin.revoke-user-session' }],
  ['/admin/revoke-user-sessions', { action: 'admin.revoke-user-sessions' }],
  ['/admin/remove-user', { action: 'admin.remove-user' }],
  ['/admin/set-user-password', { action: 'admin.set-user-password' }],
  ['/admin/has-permission', { action: 'admin.has-permission' }],
  ['/admin/provision-user', { action: 'admin.provision-user' }],
  ...STATION_SIGNUP_ADMIN_OPS.map((op): [string, AdminAction] => [
    `${STATION_SIGNUP_ADMIN_PREFIX}/${op}`,
    { action: `admin.station-signup.${op}` },
  ]),
]);

export interface FlatMount {
  /** Bare better-auth path, e.g. '/reset-password'. */
  path: string;
  /** Path-derived dotted action slug (decision 14). */
  action: string;
  /** False only for the genuinely unauthenticated mounts (no session to resolve). */
  resolveActor: boolean;
  /**
   * Which `subjectFrom` strategy this mount uses (simplify pass, code
   * review BS#2537 PR #2545 follow-up): `'actor'` echoes the resolved
   * actor id (self-service mounts — the caller's own account is both actor
   * and subject); `'email-lookup'` is the one DB read this layer performs,
   * resolving a submitted email to a user id so the email string itself
   * never lands in the table (AC#3); `'body-user-id'` is the generic
   * best-effort `body.userId` extractor (decision 12). Selected once at
   * `flatMountAuditMiddleware(mount)` construction time rather than
   * re-branching on `mount.action` per request.
   */
  subject: 'body-user-id' | 'actor' | 'email-lookup';
}

export const FLAT_MOUNTS: readonly FlatMount[] = [
  // Public (decision 11) — no session exists; mounted ahead of the Express
  // rate limiters in app.ts. device/approve+deny share that pre-limiter
  // position (and rateLimitedPaths) with forget-password/reset-password —
  // per ADR 0008 a real call to them DOES carry a session, but resolving
  // one here would be a pre-limiter DB-read DoS amplifier for garbage
  // traffic, so a real approval's actor is accepted-lost to NULL.
  { path: '/request-password-reset', action: 'forget-password', resolveActor: false, subject: 'email-lookup' },
  { path: '/reset-password', action: 'reset-password', resolveActor: false, subject: 'body-user-id' },
  { path: '/device/approve', action: 'device.approve', resolveActor: false, subject: 'body-user-id' },
  { path: '/device/deny', action: 'device.deny', resolveActor: false, subject: 'body-user-id' },

  // Authenticated self-service — mounted after the rate limiters, ahead of
  // the better-auth catch-all. subject: 'actor' — the caller's own account
  // is both actor and subject.
  { path: '/change-password', action: 'change-password', resolveActor: true, subject: 'actor' },
  { path: '/change-email', action: 'change-email', resolveActor: true, subject: 'actor' },
  { path: '/update-user', action: 'update-user', resolveActor: true, subject: 'actor' },
  { path: '/delete-user', action: 'delete-user', resolveActor: true, subject: 'actor' },

  // Authenticated organization mutations. KNOWN LIMITATION (M4, code review
  // BS#2537 PR #2545): every one of these bodies carries a target
  // identifier under a DIFFERENT field than `userId` — `invite-member` uses
  // `email`, `remove-member`/`update-member-role` use `memberIdOrEmail`/
  // `memberId`, `accept/cancel/reject-invitation` use `invitationId` — so
  // the generic `body.userId` lookup always misses and `subject_user_id` is
  // NULL on every row these mounts write. Deliberately NOT widened to also
  // try those field names: `memberIdOrEmail` can BE an email address, and
  // this column must never carry PII (the same constraint AC#3 enforces
  // for `forget-password`). Resolving a real member/invitation identifier
  // to a `subject_user_id` needs its own lookup (member -> userId,
  // invitation -> invited userId) and is a follow-up, not a drive-by fix
  // here.
  { path: '/organization/create', action: 'organization.create', resolveActor: true, subject: 'body-user-id' },
  { path: '/organization/update', action: 'organization.update', resolveActor: true, subject: 'body-user-id' },
  { path: '/organization/delete', action: 'organization.delete', resolveActor: true, subject: 'body-user-id' },
  {
    path: '/organization/invite-member',
    action: 'organization.invite-member',
    resolveActor: true,
    subject: 'body-user-id',
  },
  {
    path: '/organization/cancel-invitation',
    action: 'organization.cancel-invitation',
    resolveActor: true,
    subject: 'body-user-id',
  },
  {
    path: '/organization/accept-invitation',
    action: 'organization.accept-invitation',
    resolveActor: true,
    subject: 'body-user-id',
  },
  {
    path: '/organization/reject-invitation',
    action: 'organization.reject-invitation',
    resolveActor: true,
    subject: 'body-user-id',
  },
  {
    path: '/organization/remove-member',
    action: 'organization.remove-member',
    resolveActor: true,
    subject: 'body-user-id',
  },
  {
    path: '/organization/update-member-role',
    action: 'organization.update-member-role',
    resolveActor: true,
    subject: 'body-user-id',
  },
  { path: '/organization/leave', action: 'organization.leave', resolveActor: true, subject: 'body-user-id' },
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

const isFlatMounted = (path: string): boolean => FLAT_MOUNTS.some((mount) => mount.path === path);

/**
 * True when this bare path is covered by SOME audited mechanism (a known
 * admin action, a flat mount, or an explicit call site). Method-blind — see
 * `findUncoveredAuthApiEndpoints` for the method-aware admin + flat-mount
 * treatment arm 1 needs (a GET-only endpoint isn't actually logged by
 * either mechanism unless the admin entry's `includeGet` is set).
 */
export const isAudited = (path: string): boolean =>
  ADMIN_ACTIONS.has(path) || isFlatMounted(path) || EXPLICIT_CALL_SITES.has(path);

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
 * Method-aware in two places (M3 + simplify-pass item 4, code review
 * BS#2537 PR #2545):
 *   - Admin: a path counts as covered iff it is a KEY in `ADMIN_ACTIONS`
 *     (not merely "under the prefix" — see that map's own doc comment for
 *     why that's deliberate), and — when every method on the real endpoint
 *     is GET — only if that entry's `includeGet` flag is set.
 *   - Flat mounts: `flatMountAuditMiddleware` hard-codes `includeGet:
 *     () => false` (every FlatMount is a POST-only mutation), so a GET-only
 *     endpoint that happens to share a flat-mount's path is NOT covered by
 *     that mount and must clear the allowlist bar like anything else.
 */
export const findUncoveredAuthApiEndpoints = (endpoints: readonly AuthApiEndpoint[]): string[] =>
  endpoints
    .filter((endpoint) => {
      const getOnly = isGetOnly(endpoint.methods);
      const adminAction = ADMIN_ACTIONS.get(endpoint.path);
      const audited = adminAction
        ? !getOnly || adminAction.includeGet === true
        : isFlatMounted(endpoint.path)
          ? !getOnly
          : EXPLICIT_CALL_SITES.has(endpoint.path);
      return !audited && !isAllowlisted(endpoint.path);
    })
    .map((e) => e.path);

/**
 * Arm 2: every hand-written non-GET/OPTIONS/HEAD `/auth/...` Express route
 * registration (bare paths, `/auth` already stripped by the caller) must be
 * audited or allowlisted. Method-blind by construction: the source-text
 * sweep this feeds from only ever matches non-GET registrations in the
 * first place, so `isAudited`'s method-blind form is exactly right here.
 */
export const findUncoveredExpressRoutes = (barePaths: readonly string[]): string[] =>
  barePaths.filter((path) => !isAudited(path) && !isAllowlisted(path));
