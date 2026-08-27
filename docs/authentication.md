# Authentication

The `shared/authentication` workspace package wraps better-auth and provides JWT verification + role-based access control for the API server.

**Key files:**

- `auth.definition.ts` — better-auth config with plugins and hooks
- `auth.roles.ts` — The grant matrix (`WXYC_GRANTS` + `ORG_ADMIN_GRANTS`) and the role construction it feeds
- `auth.middleware.ts` — JWT verification and permission checking
- `auth.client.ts` — Client-side better-auth initialization
- `email.ts` — SES email sending (password reset, verification)

**Roles form a chain** — member < dj < musicDirector < stationManager — but the chain is a **CI-enforced invariant on the grant data, never a runtime mechanism**. `requirePermissions` checks each role's own flat grant set with no fallback to the role below it; the ordering is true because `tests/unit/authentication/auth.roles.test.ts` proves it, not because any code walks it. That distinction is what keeps `flowsheet: ['manage']` meaningful as its own action rather than a proxy for "MD or above".

`@wxyc/shared` owns role _identity and order_ (`ROLES`, `ROLE_ALIASES`, `canonicalizeRole`); this repo owns the **only** grant matrix. Two blocks in `auth.roles.ts`:

- **`WXYC_GRANTS`** — the station domain, typed-total: every role must decide every key (`[]` is an explicit denial), so adding a key to `statement` without deciding it for all four roles is a **compile error**. This replaced the trap where a new key granted to `dj` but left to arrive at `stationManager` via a spread produced a plain DJ with 200 and a station manager with 403.
- **`ORG_ADMIN_GRANTS`** — better-auth's own org-administration keys (`organization`/`member`/`invitation`/`team`/`ac`), held by `stationManager` alone, written out explicitly. It used to be `...adminAc.statements`, which reads as "stationManager gets everything" and is in fact a fixed library-owned set conferring no custom key.

**Permissions per role (station domain):**

| Role           | bin        | catalog    | flowsheet                                     | reviews |
| -------------- | ---------- | ---------- | --------------------------------------------- | ------- |
| member         | read/write | read       | read                                          | — (`[]`) |
| dj             | read/write | read       | read/write                                    | read    |
| musicDirector  | read/write | read/write | read/write + manage                           | read    |
| stationManager | read/write | read/write | read/write + manage (plus org administration) | read    |

`reviews: read` gates `GET /album-reviews` (ADR 0011) — the internal surface over the whole DJ form-review archive, without the public `wxycReviews` attach's `social_consent = true` filter, because the form's consent question asked only about social media and internal station tools were never in its scope. `member` decides the key as `[]`, an explicit denial rather than an omission; `stripEmpty` drops it before better-auth sees it, so the constructed role is byte-identical to one that never mentioned `reviews`.

**JWT payload**: `sub` (user ID), `email`, `role` (queried from the organization member table, not `user.role`).

**`requirePermissions` middleware flow:**

1. Extract Bearer token from `Authorization` header via the shared `parseBearerToken` helper — the Bearer scheme is matched case-insensitively per RFC 6750 §2.1 (`bearer`/`Bearer`/`BEARER`), and a bare `Bearer` with no token is rejected with 401. The same helper serves the `AUTH_BYPASS` branch so the two cannot drift (BS#1125).
2. Verify against JWKS endpoint (`BETTER_AUTH_JWKS_URL`)
3. Check issuer and audience claims
4. Resolve the role string through `normalizeRole` → `@wxyc/shared`'s `canonicalizeRole` (403 on `undefined`). This **accepts** more than `WXYCRoles`' literal keys — `admin`/`owner` and case/underscore variants resolve — and **rejects** prototype keys, which the previous `role in WXYCRoles` check let through (`role: 'toString'` resolved and then crashed the middleware with a 500). Stored and emitted role values are always the four station keys; the alias set is read-side only.
5. Check permissions using the role's authorize function
6. 403 if role invalid or permissions insufficient

**Auth bypass**: Set `AUTH_BYPASS=true` to skip JWT verification in tests. Rate limiting is disabled when `NODE_ENV=test`.

**Role mismatch gotcha**: better-auth's organization plugin has built-in roles (`owner`, `admin`, `member`) that overlap with WXYC's custom roles. A `member.role` the alias table can't resolve returns 403 on every request. Organization hooks sync admin-granting roles to `user.role='admin'` for the better-auth admin plugin — via `grantsAdminFlag` (`admin-flag-sync.ts`), which is now the **single** definition of that question. It previously existed as **five** verbatim `['stationManager', 'admin', 'owner']` copies (the grant hook, `hasOtherAdminMembership`'s SQL IN-list, `apps/auth/app.ts`'s boot reconciler `findUsersMissingAdminFlag`, `provision-user.ts`, and a backfill script); the grant path widened with the shared alias table while a hardcoded revocation list would not have, so grant and repair could accept different strings — and the boot reconciler is _specifically_ the retry path for a membership hook that failed, so a narrow copy there meant a membership the hook granted on could never be repaired if the hook died. `hasOtherAdminMembership` therefore filters in TS rather than SQL, and deliberately carries **no `.limit(1)`** — with the role predicate out of SQL, a limit would return one arbitrary membership and a user holding both a `dj` and a `stationManager` row would wrongly lose the flag.

`device-authorization.ts` deliberately does **not** use the alias table: `/device/approve` gates on `Object.hasOwn(WXYCRoles, role)`, so a stray `admin`/`owner` membership row cannot QR-approve a session. That divergence is intentional and commented at the call site.

Prior art: the unmerged `docs/auth-convergence-proposals` branch (2026-02-14) argued that admin is a system axis orthogonal to station roles and that better-auth's built-in org roles should never be _stored_ as WXYC member roles. Both hold here — `admin-flag-sync` implements the first, and nothing in this design stores built-in roles; the alias mapping is read-side normalization for stray or legacy rows only.

**Capabilities (cross-cutting, per-user grants independent of role)**: `auth_user.capabilities` (`text[]`, default `[]`) holds arbitrary capability strings — today `editor`/`webmaster`, granted via `dj-site`'s admin roster page, and `crm_merge` (BS#1884, gating `WXYC/wxyc-crm`'s donor-dedup admin tool). `getAdditionalUserInfoClaim` (`auth.definition.ts`) and the JWT plugin's `definePayload` both emit the array verbatim on the OIDC/JWT `capabilities` claim, with no per-capability-name code change required. There is no dedicated grant endpoint or UI for a capability beyond `editor`/`webmaster` — to grant any capability (including `crm_merge`) to a user, call Better Auth's `admin()` plugin `updateUser` endpoint with `data: { capabilities: [...existingCapabilities, 'crm_merge'] }`, the same call `dj-site`'s `AccountEditForm.tsx` (`updateCapabilities`) already makes in production, run from an authenticated admin session. This is an operator action (a one-off script or `curl` against the admin API), not a `Backend-Service` code path — no schema migration or `additionalFields` change is needed since `capabilities` already exists and round-trips unfiltered.

**Onboarding completeness is flag-authoritative, not field-derived**: `auth_user.has_completed_onboarding` is the single source of truth for whether a DJ has finished onboarding. dj-site's `isUserIncomplete()` reads only that flag (`hasCompletedOnboarding !== true`); it never re-derives completeness from profile fields. Onboarding-completeness logic — in the app, in a migration backfill, anywhere — must never infer "complete" from `real_name`/`dj_name` presence; a migration 0043 backfill predicate that additionally required a non-empty `dj_name` (which dj-site's `getIncompleteUserAttributes()` treats as optional) drifted from the app's real-`real_name`-only rule and silently stranded ~17 legacy DJs at `/login?incomplete=true` (BS#1451). Any future backfill of this flag must match that real_name-only rule, not invent a new predicate.
