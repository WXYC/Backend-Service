/**
 * Single source of truth for account-audit coverage (BS#2537, parent epic
 * #2534): admin action map, flat-mount table, explicit-call-site set, and
 * allowlist. `app.ts`'s mounts and `scripts/check-audit-route-coverage.ts`'s
 * three drift-check arms both import from here, so a mount and the check
 * it's measured against can't drift.
 *
 * BS#2551 (Option A): a `FlatMount` can be CONDITIONALLY audited — see
 * `BodyDiscriminator`/`classifyFlatMountAction` below. All three arms stay
 * meaningful under that: arms 1 and 3 both reason PATH-ONLY (`isFlatMounted`
 * checks membership by `.path`, never which values a `discriminator` maps),
 * so a conditionally-audited path is "covered"/"still reachable" exactly
 * like a static one — the classification has been reviewed and encoded,
 * regardless of whether a given request's body ends up matching an audited
 * value. Neither arm claims "every request through this path writes a row"
 * for a STATIC mount either (a public mount's 2xx-only subject gate already
 * means an audited path can still write a subject-NULL row) — arm coverage
 * has never meant "every write path independent of runtime data", only
 * "this path's audit behavior has been decided, not forgotten". Arm 2 never
 * sees this distinction at all (it's blind to FLAT_MOUNTS internals, method-
 * and discriminator-agnostic by construction).
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
  /**
   * MEDIUM 1 (code review BS#2537 PR #2545, second round): true for an
   * action that can DESTROY THE SESSION mid-request on the account it acts
   * on — `stop-impersonating` ends the impersonation session,
   * `remove-user`/`revoke-user-session(s)` can revoke the caller's own
   * session row if a station manager targets themselves (or another
   * manager targets them right back). The un-serialized `next()` the
   * simplify pass introduced lets the real handler and the middleware's own
   * `getSession` read run concurrently, so on these specific actions the
   * handler can delete the session row before the read completes,
   * recording `actor_user_id=NULL` on exactly the rows that matter
   * forensically most. See `account-audit-middleware.ts`'s `auditMiddleware`
   * for the carve-out this flag drives.
   */
  serializeSessionRead?: true;
  /**
   * M4 (code review BS#2547): true for an `ADMIN_ACTIONS` entry that
   * classifies a HAND-WRITTEN Express route reusing this map for the
   * runtime dispatcher's convenience, rather than a real better-auth
   * admin-plugin endpoint — `provision-user` and the six station-signup ops
   * (`STATION_SIGNUP_ADMIN_OPS`). Omitted (falsy) for every genuine
   * better-auth endpoint. `findDeclaredMountsMissingFromAuthApi`'s reverse
   * check reads this to exclude these entries — they were never in
   * `auth.api` to begin with, so checking them against it would be a
   * permanent false positive rather than a real drift signal.
   */
  handWritten?: true;
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
  ['/admin/stop-impersonating', { action: 'admin.stop-impersonating', serializeSessionRead: true }],
  ['/admin/revoke-user-session', { action: 'admin.revoke-user-session', serializeSessionRead: true }],
  ['/admin/revoke-user-sessions', { action: 'admin.revoke-user-sessions', serializeSessionRead: true }],
  ['/admin/remove-user', { action: 'admin.remove-user', serializeSessionRead: true }],
  ['/admin/set-user-password', { action: 'admin.set-user-password' }],
  ['/admin/has-permission', { action: 'admin.has-permission' }],
  // handWritten: true — app.ts's own POST /auth/admin/provision-user
  // handler, registered ahead of the better-auth catch-all, not a
  // better-auth endpoint. See AdminAction.handWritten's doc comment.
  ['/admin/provision-user', { action: 'admin.provision-user', handWritten: true }],
  // handWritten: true — the six station-signup ops are app.ts's own
  // stationSignupAdminRouter, not better-auth endpoints. See
  // AdminAction.handWritten's doc comment.
  ...STATION_SIGNUP_ADMIN_OPS.map((op): [string, AdminAction] => [
    `${STATION_SIGNUP_ADMIN_PREFIX}/${op}`,
    { action: `admin.station-signup.${op}`, handWritten: true },
  ]),
]);

/**
 * BS#2551 (Option A, decided over B/widen-scope and C/accept-gap): lets ONE
 * `FlatMount.path` serve more than one logical better-auth operation while
 * only some of them are audited — `/email-otp/send-verification-otp` is a
 * single endpoint discriminated by a `type` body field into `sign-in`,
 * `email-verification`, and `forget-password`, and only the last is in the
 * epic #2534-ratified audited scope (sign-in/sign-up stay out). `field`
 * names the discriminating body key; `actions` maps a body value to its own
 * action slug. A body value ABSENT from `actions` (including a missing or
 * non-string field) is not audited at all — `classifyFlatMountAction`
 * returns null and the request writes zero `account_audit_event` rows, the
 * same "unknown → skip" shape `ADMIN_ACTIONS`'s map-miss gate already uses.
 * This is how a `type: 'sign-in'` call through this path stays silent while
 * a `type: 'forget-password'` call on the exact same path records — without
 * scattering a body check into the middleware as a route-specific `if`.
 */
export interface BodyDiscriminator {
  /** Request-body field this mount's real operation is selected by. */
  field: string;
  /** Body value (as submitted, not normalized) -> its own dotted action slug. */
  actions: Readonly<Record<string, string>>;
}

interface FlatMountFields {
  /** Bare better-auth path, e.g. '/reset-password'. */
  path: string;
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
  /** Same MEDIUM 1 flag as `AdminAction.serializeSessionRead` (see that doc comment) — set only on `delete-user`, the one FlatMount whose action destroys the caller's own session mid-request. */
  serializeSessionRead?: true;
}

/**
 * A `FlatMount` carries EITHER a static `action` (decision 14's plain
 * path-derived slug — the overwhelming majority of mounts, whose action
 * never depends on anything in the request) OR a `discriminator` (BS#2551
 * Option A) — never both, never neither. The union (rather than an optional
 * `action` + optional `discriminator` on one interface) makes "exactly one"
 * a compile-time property instead of a runtime invariant some future mount
 * could violate silently.
 */
export type FlatMount =
  | (FlatMountFields & { action: string; discriminator?: undefined })
  | (FlatMountFields & { action?: undefined; discriminator: BodyDiscriminator });

/**
 * The one place a `FlatMount`'s runtime action is resolved from a request —
 * pure and co-located with the data it reads, so it's unit-testable without
 * Express (mirrors decision 4's "the compare function is unit-tested"
 * doctrine for the drift-check arms below). A static mount ignores `body`
 * entirely; a discriminated mount returns null for anything other than an
 * exact string match in `discriminator.actions` — no fuzzy matching, no
 * case-folding (better-auth's own `type` enum is submitted verbatim by
 * every real client, never normalized the way `email` is).
 */
export const classifyFlatMountAction = (mount: FlatMount, body: unknown): string | null => {
  if (mount.discriminator === undefined) return mount.action;
  const value = (body as Record<string, unknown> | null | undefined)?.[mount.discriminator.field];
  return typeof value === 'string' ? (mount.discriminator.actions[value] ?? null) : null;
};

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

  // OTP-based password-reset flow (BS#2547, M5 re-decision recorded
  // 2026-09-17, parent epic #2534). The token-based flow above
  // (`forget-password`/`reset-password`) has always been audited; these
  // three were allowlisted at ship time (code review BS#2537 PR #2545,
  // finding M5) with a comment marking them as needing an explicit
  // re-decision, now resolved: audited. Path-derived dotted slugs distinct
  // from the token flow's `forget-password` (decision 14) — a forensic
  // query must be able to tell the OTP arm from the token arm. All three
  // carry a plain `email` field in the request body (confirmed against the
  // installed emailOTP plugin, node_modules/better-auth/dist/plugins/email-otp/routes.mjs:
  // `ctx.body.email` on all three), so the existing `email-lookup` strategy
  // applies unchanged, including its 2xx + writableFinished gate. Same
  // pre-rate-limiter public-mount position and DoS-amplifier reasoning as
  // `forget-password` above — see `app.ts`'s `rateLimitedPaths` for the
  // three new limiter entries this requires.
  {
    path: '/email-otp/request-password-reset',
    action: 'email-otp.request-password-reset',
    resolveActor: false,
    subject: 'email-lookup',
  },
  {
    path: '/email-otp/reset-password',
    action: 'email-otp.reset-password',
    resolveActor: false,
    subject: 'email-lookup',
  },
  // `/forget-password/email-otp` is better-auth's own @deprecated alias for
  // `/email-otp/request-password-reset` (still live, still reachable) — a
  // real, working, unaudited path today, audited for the same reason as its
  // non-deprecated twin above.
  {
    path: '/forget-password/email-otp',
    action: 'forget-password.email-otp',
    resolveActor: false,
    subject: 'email-lookup',
  },
  // BS#2551 (Option A, decided over B/widen-scope and C/accept-gap; M2,
  // code review BS#2550): `/email-otp/send-verification-otp` is a SHARED
  // endpoint — better-auth's `type` enum on it is `sign-in`,
  // `email-verification`, or `forget-password` (`change-email` is rejected
  // with a 400 before it ever resolves an OTP — confirmed against
  // node_modules/better-auth/dist/plugins/email-otp/routes.mjs). Called
  // with `type: 'forget-password'` it runs the identical `resolveOTP(...,
  // 'forget-password')` path and mails the same working reset code as the
  // dedicated `email-otp.request-password-reset` mount above — the
  // forensic gap this ticket closes. `type: 'sign-in'` is the epic
  // #2534-ratified allowlisted flow (every current WXYC client's real
  // traffic here) and must stay silent; `type: 'email-verification'` was
  // never in audited scope either. The discriminator is exactly this: ONE
  // value maps to an action, every other value (or a missing/non-string
  // `type`) classifies to null and writes nothing — see
  // `classifyFlatMountAction`.
  //
  // Action slug: `email-otp.send-verification-otp.forget-password`, not
  // the bare path-derived `email-otp.send-verification-otp`. Decision 14
  // is "path-derived dotted slugs", and this extends that convention
  // one dot further — the same shape `ADMIN_ACTIONS` already uses for
  // `admin.station-signup.<op>` (path prefix + a variant suffix), except
  // the suffix here comes from the request body rather than a literal
  // path segment, since the variant isn't reachable as its own path. Two
  // reasons this is worth the extra segment over the bare slug: (1) a
  // reader querying `action = 'email-otp.send-verification-otp.forget-
  // password'` doesn't need to already know the discriminator's existence
  // to know what happened — a bare `email-otp.send-verification-otp`
  // would only be unambiguous BECAUSE this table happens to audit exactly
  // one of the endpoint's three types, an invariant a future re-decision on
  // the email-change types could quietly break; (2) it stays distinct from
  // the sibling `email-otp.request-password-reset` action even though both
  // endpoints run the same underlying `resolveOTP` call and are, for a DJ,
  // functionally interchangeable password-reset requests — the epic's
  // whole M2 complaint was that two interchangeable endpoints answered
  // "who requested this reset code" differently, and collapsing their
  // action slugs together now would make that no longer answerable from
  // the recorded action alone (was it requested via the dedicated reset
  // endpoint or the shared send-verification-otp one).
  //
  // Rate limiting: this path stays in `app.ts`'s shared `rateLimitedPaths`
  // (`authMutationRateLimit`, 15min/10) rather than moving to the
  // dedicated `otpPasswordResetSendRateLimit` PR #2550 introduced for the
  // two other email-sending reset mounts. Both tiers are NUMERICALLY
  // IDENTICAL (15min/10) — there is no "looser bucket" hazard to fix, only
  // a "shared with sign-in" one. Left shared deliberately: every real call
  // to this endpoint today carries `type: 'sign-in'` (no WXYC client sends
  // `forget-password` here — see the issue's reachability note), so the
  // shared bucket is bucketing the traffic it actually has, correctly.
  // Splitting the limiter to isolate the newly-audited-but-currently-
  // unreachable forget-password variant would need a NEW mechanism
  // (body-discriminated rate limiting, peeking `req.body.type` before
  // choosing a limiter instance) that no acceptance criterion here calls
  // for and that this ticket's scope (audit classification, Option A) does
  // not touch. If forget-password traffic through this shared endpoint
  // ever becomes real, that split is a follow-up, not a silent regression
  // introduced by leaving it alone now.
  {
    path: '/email-otp/send-verification-otp',
    resolveActor: false,
    subject: 'email-lookup',
    discriminator: {
      field: 'type',
      actions: { 'forget-password': 'email-otp.send-verification-otp.forget-password' },
    },
  },

  // Authenticated self-service — mounted after the rate limiters, ahead of
  // the better-auth catch-all. subject: 'actor' — the caller's own account
  // is both actor and subject.
  { path: '/change-password', action: 'change-password', resolveActor: true, subject: 'actor' },
  { path: '/change-email', action: 'change-email', resolveActor: true, subject: 'actor' },
  { path: '/update-user', action: 'update-user', resolveActor: true, subject: 'actor' },
  { path: '/delete-user', action: 'delete-user', resolveActor: true, subject: 'actor', serializeSessionRead: true },

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

  // OTP send/verify — ratified as-written by the issue's allowlist bucket
  // ("OTP send/verify"), NOT a dead-code judgment call: the emailOTP plugin
  // IS configured and live in this deployment.
  //
  // `/email-otp/send-verification-otp` is DELIBERATELY ABSENT from this
  // allowlist, not merely renamed out of it: BS#2551 (Option A) moved it to
  // `FLAT_MOUNTS` with a `discriminator`, so it is CONDITIONALLY audited —
  // `type: 'forget-password'` records, `type: 'sign-in'` (and everything
  // else) stays silent, same as before. `isFlatMounted`/`isAudited` treat
  // the path as covered regardless of which discriminated value a given
  // request carries — "covered" here means "this path's classification has
  // been reviewed and encoded", not "every request through it writes a
  // row"; ADMIN_ACTIONS' own `includeGet` flag already draws that same
  // distinction for GET vs non-GET on one path. See the FLAT_MOUNTS entry
  // above for the full M2-gap history (BS#2547 code review) and the action-
  // slug rationale. `check-verification-otp` and `verify-email` below are
  // unaffected — a check/verify step is never the ticket's audited action
  // (that authority lives at completion, `email-otp.reset-password`) and
  // BS#2551 never proposed touching either.
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  // LIVE, UNAUDITED account-modifying flows — M5 RE-DECISION (BS#2547,
  // 2026-09-17): this hole originally covered FIVE OTP paths (code review
  // BS#2537 PR #2545, finding M5). The three password-reset-flow arms
  // (`/email-otp/request-password-reset`, `/email-otp/reset-password`,
  // `/forget-password/email-otp`) were re-decided as "audited" and moved to
  // FLAT_MOUNTS above. These two EMAIL-CHANGE arms are explicitly NOT
  // covered by that re-decision and remain pending one of their own — they
  // change the account's email via a code instead of a token, exactly like
  // the audited /change-email mount above, but still ship zero
  // account_audit_event rows.
  '/email-otp/change-email',
  '/email-otp/request-email-change',

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

/**
 * Arm 3 (M4, code review BS#2547): the reverse direction of arm 1. Arm 1
 * only ever asks "is every REACHABLE auth.api endpoint audited-or-
 * allowlisted" — it says nothing about a declared mount whose endpoint has
 * since been removed upstream. better-auth marks `/forget-password/email-otp`
 * `@deprecated — will be removed in the next major version`; when that
 * happens, arm 1 stays green (nothing newly unreachable needs classifying)
 * while the `FLAT_MOUNTS` row, `app.ts`'s limiter string, and the
 * documented action slug all silently become dead strings that can never
 * fire again — the same defect class the BS#2537 M1 fix closed for the dead
 * `/auth/forget-password` string (see this file's header comment). This arm
 * catches that: every `FLAT_MOUNTS.path` and every `ADMIN_ACTIONS` key NOT
 * flagged `handWritten` must still be a real, currently-reachable `auth.api`
 * path.
 *
 * `handWritten` exclusion: `provision-user` and the six
 * `/admin/station-signup/*` entries classify HAND-WRITTEN Express routes
 * (`app.ts`'s own `provision-user` handler and `stationSignupAdminRouter`),
 * reusing this map purely for the runtime dispatcher's convenience —
 * `adminPrefixAuditMiddleware`'s canonical-path lookup doesn't care whether
 * the path behind it is a real better-auth endpoint or not. They were never
 * in `auth.api` and checking them here would be a permanent false positive,
 * not a drift signal (confirmed by running this check before adding the
 * flag: `/admin/provision-user` failed immediately). Station-signup's own
 * coverage lives in `account-audit-mount-order.test.ts`'s
 * `STATION_SIGNUP_ADMIN_OPS` parity assertion instead.
 */
export const findDeclaredMountsMissingFromAuthApi = (endpoints: readonly AuthApiEndpoint[]): string[] => {
  const reachable = new Set(endpoints.map((e) => e.path));
  const missingFlatMounts = FLAT_MOUNTS.filter((mount) => !reachable.has(mount.path)).map((mount) => mount.path);
  const missingAdminActions = [...ADMIN_ACTIONS.entries()]
    .filter(([path, action]) => action.handWritten !== true && !reachable.has(path))
    .map(([path]) => path);
  return [...missingFlatMounts, ...missingAdminActions];
};
