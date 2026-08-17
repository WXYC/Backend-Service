# BS#2171 — narrow `auth_user.role` to the better-auth admin flag, and enforce it in the schema

Issue: [WXYC/Backend-Service#2171](https://github.com/WXYC/Backend-Service/issues/2171). Worktree `.worktrees/2171-auth-user-role-narrow`, based on `origin/main` at `b78d8308`.

**Revision 6 — approved (r6: "approve with suggestions", all six findings verified against the codebase and folded in).** r2: §7 rewritten, §1 DDL corrected, §4 extended to the OIDC path, §6 reversed from delete to narrow. r3: §0 extraction added, §5's demotion narrowed, `CLAUDE.md:117` added to the stale-claim sweep. r4: write-side guard is `roles` not `adminRoles`, test 9 retargeted, `/admin/update-user` + `anonymous()` added to the inventory, predicate made paren-free, §8 folds in the orphan case. **r5:** the `roles` pin alone does **not** close the comma hole — §2 gains a request-level guard; §5 now states the value it writes; the jest mock is spelled out as a new file; **the work splits into two chained PRs** per the ≤1000-line guidance; test file paths named; `dev_env/seed_db.sql` added to the inventory as explicitly checked. **r6:** §3's fallback must drop `role` **by destructure**, never by narrowing — the payload also carries `banned`/`banReason`, which `auth.middleware.ts:183-188` reads; the §2 guard is extracted into a fourth §0 module so test 12 becomes a unit test; `roles` pins to the imported `defaultRoles`; the "only prior CHECK" claim was wrong (0101 is precedent); two `docs/migrations.md` citations renumbered; the barrel requirement dropped.

## Decision

The ticket offers Option A (narrow the column) and Option B (sync it and backfill 91 rows). **We take A, plus a `CHECK` constraint that makes the drift structurally impossible** — the ticket's own closing advice is "prefer making the unmaintained read impossible over adding a fallback," and a constraint is the strongest available form of that.

Option B is rejected: nothing in the codebase wants to read a station role off `auth_user`, so B pays a 91-row production auth write to make a column truthful that nothing asks, and re-creates the denormalization that caused #1222. It also contradicts `@wxyc/shared`, whose `ROLES` is `["stationManager","musicDirector","dj","member"]` — no `admin` — alongside a separate `isSystemAdmin(user)` documented as _"orthogonal to the WXYC station role hierarchy."_

### The constraint alphabet, and why it is not `{NULL, 'admin'}`

The obvious constraint — `role IS NULL OR role = 'admin'` — **would break user creation.** better-auth's admin plugin registers a `databaseHooks.user.create.before` that stamps a role on every create:

```js
// node_modules/better-auth/dist/plugins/admin/admin.mjs:26-31
user: { create: { async before(user) {
  return { data: { role: options?.defaultRole ?? "user", ...user } };
} } },
```

`defaultRole` defaults to `"user"` (`admin.mjs:14`), and `admin()` is called with no options today (`shared/authentication/src/auth.definition.ts:201`). So the legal alphabet is **`NULL | 'user' | 'admin'`** — the closed set the current writers produce:

| Writer                                                           | Value written                                       | Guarded after §2?              |
| ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| `user.create.before` hook                                        | `'user'`                                            | n/a                            |
| `/admin/create-user` — `routes.mjs:173-177`, `:198`              | requested role, else `'user'`                       | **needs the §2 request guard** |
| `/admin/set-role` — `routes.mjs:70-76`                           | arbitrary string / comma-join                       | **needs the §2 request guard** |
| `/admin/update-user` — `routes.mjs:265-271`                      | arbitrary string / comma-join                       | **needs the §2 request guard** |
| `anonymous()` plugin — `auth.definition.ts:205`                  | `'user'`, via the create hook                       | n/a                            |
| `provisionUser()` step 9 — `apps/auth/provision-user.ts:176-177` | `'admin'`                                           | n/a                            |
| `afterAddMember` — `auth.definition.ts:305`                      | `'admin'`                                           | n/a                            |
| `afterUpdateMemberRole` — `:336`, `:340`                         | `'admin'` / `null`                                  | n/a                            |
| `afterRemoveMember` — `:379`                                     | `null`                                              | n/a                            |
| `syncAdminRoles()` — `apps/auth/app.ts:497`                      | `'admin'` (+ `null`, §5)                            | n/a                            |
| `scripts/backfill-missing-org-members.ts:156`                    | `'admin'`                                           | n/a                            |
| `dev_env/seed_db.sql:22-46`                                      | `'admin'` ×2, `NULL` ×10 — **verified in-alphabet** | n/a                            |

**This service has no ordinary email signup** — `disableSignUp: true` at `auth.definition.ts:97` (and `:428` for OTP). The live creation paths are `/admin/create-user`, `anonymous()`, and `provisionUser()`, all routing through the same create hook.

`provisionUser()` calls `internalAdapter.createUser` **without** a `role` field (`apps/auth/provision-user.ts:109-120`), so the hook supplies `'user'` and step 9 overwrites with `'admin'` only for `ADMIN_SYNC_ROLES`. Station roles never reach this column through any current path. An org-wide `rg` for `admin/set-role`, `setRole`, `admin.setRole` returns **zero hits**; dj-site's roster edits go through `authClient.organization.updateMemberRole` (`AccountEditForm.tsx:134`), which writes `auth_member.role` only.

That leaves exactly **10 rows** to normalize — the legacy `dj` cohort created through bare `/admin/create-user` before `provisionUser()` existed.

**Two encodings of "not an admin" already exist and both stay legal.** better-auth's create hook writes `'user'`; the demotion hooks write `null` (`auth.definition.ts:340`, `:379`). Both resolve to `Authorization.NO`. The constraint permits both; §7 documents the equivalence in one place so it stops being folklore.

### Reader inventory

| Reader                                                                        | Kind                             | Action                             |
| ----------------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| better-auth admin plugin, internal                                            | admin flag (`=== 'admin'`)       | keep — load-bearing for `/admin/*` |
| `syncAdminRoles()` self-query — `apps/auth/app.ts:481`, `:490`                | admin flag                       | keep, extend with demotion         |
| JWT `definePayload` fallback — `auth.definition.ts:236-240`                   | **accidental station-role read** | fix — fail closed                  |
| `mapUserRoleToMemberRole()` — `scripts/backfill-missing-org-members.ts:48-55` | station-role read                | narrow                             |

Everything else that touches the column is a write.

## The second copy of the #1222 bug

`definePayload` overrides `role` with `member.role` on the happy path, but its fallback returns `{ ...user }` — placing `auth_user.role` into the JWT `role` claim. `roleToAuthorization('admin')` returns `Authorization.SM`. When the membership query throws or returns empty:

| Cohort             | JWT `role` claim | Resolves to |                                                |
| ------------------ | ---------------- | ----------- | ---------------------------------------------- |
| 8 station managers | `admin`          | **SM**      | privilege sustained by the unmaintained column |
| 1 music director   | `user`           | **Member**  | silently demoted                               |
| 10 legacy DJs      | `dj`             | DJ          | accidentally right                             |
| 90 DJs             | `user` / `null`  | **Member**  | silently demoted                               |

Same failure class #1223 removed from the roster, one layer down, in the value authorization actually consumes.

The OIDC `id_token` path is separate: `oidcProvider` overrides `definePayload: () => payload` (`node_modules/better-auth/dist/plugins/oidc-provider/index.mjs:645`), so the app's `definePayload` never reaches an `id_token`. §4 handles it on its own terms.

## Open decision for the reviewer

**What should a station manager get when the membership lookup fails at token-mint time?**

- _Today:_ stale `'admin'` → SM access preserved. Fail-open, backed by a column nobody maintains.
- _Proposed:_ omit the claim → `shared/authentication/src/auth.middleware.ts:196-197` returns `403 Forbidden: Missing role in token.`

The plan assumes **fail-closed**. Sizing, all verified:

- **Duration ≤15 min.** The JWT plugin defaults to a 15-minute expiry (`node_modules/better-auth/dist/plugins/jwt/sign.mjs:13`, `expirationTime ?? "15m"`); the config does not override it. The `expiresIn: 60*60*24*365` at `auth.definition.ts:78` is the _session_, not the token.
- **Only permission-declaring routes.** The gate runs behind `Object.keys(required).length > 0` (`auth.middleware.ts:193`); `requirePermissions({})` and anonymous paths are unaffected.
- **Clients degrade rather than break.** dj-site's `AuthorizedView.tsx:38-66` already falls back to `listMembers` and then to `Authorization.NO`; iOS's `JWTPayload.role` is `String?`. An absent claim is a handled case on both consumers.

The argument for it: today's fallback is not a clean fail-open. It reads a column nothing maintains, so it is right for 18 users and silently wrong for 91. A 403 gets reported in minutes; a quietly-demoted music director went unnoticed for months. **Flagged for override.**

## Changes

### 0. Extract the logic under test (ships as its own PR — see Sequencing)

The behavior this plan changes lives in unreachable places:

- `definePayload` and the three `organizationHooks` are inline properties of the `betterAuth({...})` literal in `shared/authentication/src/auth.definition.ts` — nothing exports them.
- `syncAdminRoles` is a module-local `const` at `apps/auth/app.ts:465`; the module's only export is `export default app` (`:572`), reached _after_ a top-level IIFE calling `app.listen()` (`:553`). Importing it starts a server.
- `jest.unit.config.ts:20` maps `@wxyc/authentication` → `tests/mocks/authentication.mock.ts`.

Every existing unit test against this file is a source-scan (`tests/unit/authentication/oidc-provider-public-client-jwt.test.ts:54`, `oidc-provider-schema.test.ts:52`, `cookie-config.test.ts:9`, `session-config.test.ts:33`), and the first says why: _"A behavior test would require spinning up the full better-auth instance against a live PG, which is over budget for a unit test."_

**The repo already has the answer.** `shared/authentication/src/device-authorization.ts` extracts three helpers out of the same literal, and `tests/unit/authentication/device-authorization.test.ts` imports them **by relative path** with **DB access injected as callbacks**.

| New module                                            | Exports                                                                                      | Injected deps                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `shared/authentication/src/jwt-payload.ts`            | `buildJwtPayload`, `buildOidcUserInfoClaim`                                                  | `fetchMemberRole(userId)`, `onError(e)`                                   |
| `shared/authentication/src/admin-flag-sync.ts`        | `syncAdminFlagOnAddMember`, `syncAdminFlagOnUpdateMemberRole`, `syncAdminFlagOnRemoveMember` | `setUserRole(userId, role)`, `findAdminMemberships(userId)`, `onError(e)` |
| `apps/auth/sync-admin-roles.ts`                       | `syncAdminRoles`                                                                             | query + update callbacks, `onError(e)`                                    |
| `shared/authentication/src/admin-role-write-guard.ts` | `assertScalarRoleWrite`                                                                      | none (pure)                                                               |

Two mechanical requirements:

- **Do not add these to the barrel.** `shared/authentication/src/index.ts` does _not_ re-export every sibling — `oidc-login-page.ts` and `url-rewrite.ts` are both absent, and `:7-12` use named exports rather than `export *`. The new modules are consumed only by `auth.definition.ts` and by tests, both via relative import, so a barrel entry would widen `@wxyc/authentication`'s public surface for no consumer.
- **All new modules must import only _types_ from `@wxyc/database`.** A value import re-engages the DB mock at `jest.unit.config.ts:19` and defeats the callback injection.

The three org hooks share near-identical logic today (`DEFAULT_ORG_SLUG` check → org-slug match → admin-role-set test), so the extraction removes real duplication rather than only serving the tests.

### 1. Schema + migration `0150_narrow-auth-user-role`

`shared/database/src/schema.ts`, `user` table extra-config array (`:68-76`) — matching the `check()` convention at `:387`, `:761`, `:2655`:

```ts
check('auth_user_role_system_only', sql`${table.role} IS NULL OR ${table.role} = 'user' OR ${table.role} = 'admin'`),
```

**Paren-free on purpose.** `scripts/schema-shape-report.mjs:334-335` parses migration CHECKs with a non-greedy `CHECK\s*\((.*?)\)`, stopping at the first `)`. An `IN ('user','admin')` form truncates to an unbalanced predicate. Three equality terms are semantically identical and parse cleanly. The disjunction form has direct precedent: `0101_rotation-discogs-release-id-not-sentinel.sql:98` already ships `CHECK ("…"."discogs_release_id" IS NULL OR "…"."discogs_release_id" > 0)` — same `IS NULL OR …` shape, same paren-free predicate — and `0118_library-discogs-unavailable.sql:41` adds a third.

Plus a column comment on `role` (`:52`) naming `auth_member.role` as the station-role source of truth.

Migration generated with `npm run drizzle:generate` (`docs/migrations.md:42`, `journal-snapshot-coupling`). Hand-prepend the comment block per `sql-comment-block` (`:54`); the DDL stays byte-for-byte as emitted. Drizzle emits fully schema-qualified predicates — precedent at `0140_cta-track-artist-link.sql:109` — and `auth_user` is a `public`-schema table (bare `pgTable`; `"public"."auth_user"` in `0021_user-table-migration.sql:28`). **Generate first, then paste the emitted line into this plan and the PR body.** Expected shape:

```sql
-- @no-precondition-needed: the UPDATE immediately below normalizes every row
-- outside the alphabet, so the ADD CONSTRAINT cannot fail.
-- @no-analyze-needed: 10 rows on a 110-row table; no index the planner reads.
--
-- Alphabet is scalar-only by design. better-auth can persist comma-joined
-- multi-role values ("admin,user"); the request guard in auth.definition.ts
-- rejects those with a 400 before they reach this constraint. Widening the
-- predicate to accept comma lists would restore the ambiguity it removes.

UPDATE "public"."auth_user" SET "role" = 'user'
 WHERE "role" IS NOT NULL AND "role" <> 'user' AND "role" <> 'admin';

-- (generated line, to be replaced verbatim with drizzle-kit output)
ALTER TABLE "public"."auth_user" ADD CONSTRAINT "auth_user_role_system_only" CHECK (...);
```

Constraints: journal `when` = previous + 1ms (`hand-edit-when`, `docs/migrations.md:46`; incidents #400/#550), re-checked at merge for `parallel-pr-when-collision` (`:50`); PG14 syntax only (prod RDS 14.22 vs dev/CI 18.0 — `dev-prod-pg-version-skew`, BS#1424); suppression annotations inlined at authoring time, which the rules permit; DML is 10 rows, far under the ~10k `ddl-only` threshold (`:62`).

**Expected CI signal.** Touching db-init paths triggers `migrate-dryrun` against a restored RDS snapshot — the only job validating against prod's PG major, and the real gate. Its `schema-shape-report.mjs` pre-probe will still fail here: `qualifiedTable()` (`:394`) unconditionally prefixes `SCHEMA_NAME` (`:64`, default `wxyc_schema`) while `migRe` captures a bare `auth_user`, so it targets a nonexistent `"wxyc_schema"."auth_user"`. **Expect a probe failure, advisory only** — the script self-describes as non-blocking (`:775-776`). Say so in the PR body.

This is not specific to this migration. Every `auth_*` table is a bare `pgTable`, so the probe mis-targets _any_ future public-schema constraint — the script silently reports "constraint absent" for a constraint that is present. **File a follow-up issue against `schema-shape-report.mjs`** and link it from the PR body next to the expected-failure note, so the advisory failure has a tracked owner instead of becoming folklore. Ask before filing — it is a separate defect from #2171.

### 2. Close the write paths: pin `roles` **and** guard the request

`shared/authentication/src/auth.definition.ts:201`:

```ts
import { defaultRoles } from 'better-auth/plugins/admin/access';

admin({ defaultRole: 'user', adminRoles: ['admin'], roles: defaultRoles });
```

Import the upstream symbol rather than hand-listing `{ admin: adminAc, user: userAc }`. `access/statement.mjs:47-50` exports `defaultRoles` as exactly that object, and `better-auth/plugins/admin/access` is a real package subpath export. Importing it keeps the pin in lockstep with upgrades — which is the point, since "a better-auth upgrade changes `defaultRole`" is already on the risk table.

**The pin alone is not sufficient, and r4 claimed otherwise.** `adminRoles` is read-side only (`routes.mjs:585-586`). `opts.roles` is the write-side allowlist — but it validates **element-wise and then joins**:

```js
// routes.mjs:71-76 (/admin/set-role); identically at :265-271 and :173-177
const inputRoles = Array.isArray(ctx.body.role) ? ctx.body.role : [ctx.body.role];
for (const role of inputRoles) if (!roles[role]) throw APIError.from("BAD_REQUEST", ...);
...
{ role: parseRoles(ctx.body.role) }   // -> roles.join(",")
```

So `{"role": ["admin","user"]}` passes the pinned guard — both keys exist — and writes `"admin,user"`, which the new CHECK rejects as an **unhandled 23514 (500)**. Pinning `roles` is still worth doing (it restores a 400 for genuinely unknown values, and `admin()` passes no `roles` today so that branch is skipped entirely), but it does not close the comma hole.

**Add a request-level guard, extracted like everything else in §0.** There is already a `hooks.before` at `auth.definition.ts:445`, a single `createAuthMiddleware` that early-returns on path mismatch (`if (ctx.path !== '/device/approve') return;`). better-auth takes one `before` hook, so **extend that middleware** rather than adding a second.

The policy itself goes in `shared/authentication/src/admin-role-write-guard.ts` as a pure function, not inline in the middleware:

```ts
export function assertScalarRoleWrite(path: string, body: { role?: unknown }): void;
```

It throws `APIError` with a 400 for an array-valued or comma-bearing `role` on `/admin/set-role`, `/admin/update-user`, or `/admin/create-user`, and returns silently otherwise. This is the same shape as `applyDeviceApproveRoleGate` (`device-authorization.ts:24`), which throws `APIError` and is unit-tested at `tests/unit/authentication/device-authorization.test.ts:24`.

Extracting it matters more here than elsewhere: this guard is the only thing standing between a malformed request and an unhandled 23514, and leaving it inline would force test 12 to be an integration test against a live admin session. Extracted, it is a pure-function unit test with **no new mock infrastructure** — `APIError` is already stubbed at `tests/mocks/better-auth-api.mock.ts:4` and mapped at `jest.unit.config.ts:43`. `createAuthMiddleware` is likewise already imported at `auth.definition.ts:19`; add `APIError` to that same import.

Note `/admin/create-user` is unguarded today and is precisely how the 10 legacy `dj` rows came to exist.

Two gotchas:

- Passing `adminRoles` explicitly activates a construction-time validation branch (`admin.mjs:18-20`) that throws `BetterAuthError` if an entry is not a key of `roles`. `['admin']` is a valid subset of the pinned set; keep it so.
- Pinning to `defaultRoles` is semantically a no-op — the plugin would compute the same set. The value is entirely in _activating_ the validation branch that `opts.roles === undefined` skips.
- `better-auth/plugins/admin/access` is an ESM subpath. If any unit test ends up resolving it, it needs a new `tests/mocks/better-auth-admin-access.mock.ts` (one export: `defaultRoles`) plus a `moduleNameMapper` entry at `jest.unit.config.ts:40-43` — the existing `better-auth-access.mock.ts` exports only `createAccessControl` and cannot serve it. **Verify whether it is needed at all before writing it:** every current unit test against `auth.definition.ts` is a source-scan, and §0's extraction deliberately keeps the new logic out of that file, so nothing may import it. Write the mock only if a test actually fails to resolve.

### 3. JWT payload — fail closed, but drop _only_ `role`

`buildJwtPayload` (extracted in §0 from `auth.definition.ts:236-240`). The fallback must not spread `role` through from `user`.

**Drop `role` by destructure — do not narrow the payload.** `auth.middleware.ts:183-188` gates banned accounts on `payload.banned` / `payload.banReason`, and its own comment says the field arrives "in JWT payload via `...user` spread" — i.e. it reaches the middleware _only_ through the spread at `auth.definition.ts:238`. Returning a hand-built narrow object on the fallback path would silently un-ban every suspended account whose token was minted through it. The fix must be subtractive:

```ts
const { role: _unusedSystemRole, ...rest } = user;
return { ...rest, capabilities: userWithCapabilities?.capabilities ?? [] };
```

Route the catch through the injected `onError` so the call site can `Sentry.captureException` (matching `{ level: 'warning', tags: { subsystem: 'admin-sync' } }` at `apps/auth/app.ts:505`).

A test in the tests 1–3 group asserts the fallback still carries `banned` and `banReason` — this is the failure mode most likely to survive review unnoticed, because a fail-closed change that accidentally fails _open_ on a different axis looks correct in every test that only asserts on `role`.

### 4. Make every swallowed role-sync failure loud

| Site (`shared/authentication/src/auth.definition.ts`) | Line       | Current posture                 |
| ----------------------------------------------------- | ---------- | ------------------------------- |
| `afterAddMember`                                      | `:311`     | `console.error` only            |
| `afterUpdateMemberRole`                               | `:346`     | `console.error` only            |
| `afterRemoveMember`                                   | `:385`     | `console.error` only            |
| `getAdditionalUserInfoClaim`                          | `:275-277` | bare `catch`, no logging at all |

The first three are the realistic mechanism by which a demoted station manager keeps `role = 'admin'` forever. Route all three through the extracted helpers' `onError`.

The fourth is the OIDC `id_token` path. It degrades to `role: 'member'` on both empty and thrown — already fail-closed in the privilege sense, and it does **not** carry the `auth_user.role` leak §3 fixes. **Proposed:** add the Sentry capture, keep the `'member'` degrade. An absent `role` in an `id_token` breaks OIDC sign-in at the relying party rather than at a single API call. Record that in a comment so the divergence is deliberate.

### 5. `syncAdminRoles()` — a demotion branch that cannot strip a legitimate admin

`apps/auth/sync-admin-roles.ts` (extracted in §0 from `apps/auth/app.ts:465-506`). Add the inverse of the existing promote query, with one restriction and one explicit value.

**Writes `null`, not `'user'`** — matching the three existing demotion paths (`auth.definition.ts:340`, `:379`). §1's one-time normalization writes `'user'` because those rows are creation-default artifacts, not demotions; the two encodings are equivalent and §7 documents that. Test 5 asserts `null` specifically.

**Demote only where the org join succeeds** and `member.role NOT IN ('admin','owner','stationManager')`. The naive form ("membership absent **or** not admin-ish") is unsafe: an absent membership is exactly the orphan §8 covers, produced when the `user.create.after` safety net swallows its insert error (`auth.definition.ts:593`). This reconciler runs on **every auth-service boot**, so the naive form would let a transient signup-time error silently strip admin from a legitimate station manager on the next restart — with no membership row left to re-promote from.

Report the absent-membership case to Sentry and take no action. Keep the `DEFAULT_ORG_SLUG`-unset early return governing both directions.

### 6. `mapUserRoleToMemberRole()` — narrow the inverted derivation, keep the script

`scripts/backfill-missing-org-members.ts:48-55` derives `auth_member.role` _from_ `auth_user.role` across **four** branches (`admin`, `dj`, `musicDirector`, `stationManager`) — the mechanism by which a legacy `user`/`null` becomes a permanent `auth_member.role = 'member'`.

r1 proposed deleting the script. **Reversed** — `auth.definition.ts:593` names it as the operator's documented recovery path from inside the `user.create.after` safety net's own error handler. Deleting it would orphan that instruction and remove the remediation for exactly the case §5 now refuses to act on. (Otherwise unreferenced: no `package.json` script, no CI, no test.)

**Instead:** reduce the mapping to `admin → stationManager` — removing three of four branches — and require an explicit `--default-role` for every other input. Update the header comment at `:13-16`, which documents the full mapping.

### 7. Documentation — amend in place

`docs/authentication.md` already answers the ticket's first acceptance criterion in two places; a new section would produce two overlapping answers. Amend both:

- `:24` — the **JWT payload** line already says `role` is "queried from the organization member table, not `user.role`". Add §3's fail-closed behavior.
- `:37` — the **Role mismatch gotcha** already says the org hooks sync to `user.role='admin'`. Add the alphabet, the constraint name, that `auth_member.role` is the sole station-role source of truth, **and that `NULL` and `'user'` are equivalent encodings of "not a better-auth admin."**

At `:39`: that paragraph instructs operators to grant capabilities via the admin plugin's `updateUser` with `data: {...}` — the same call dj-site's `AccountEditForm.tsx` (`updateCapabilities`) already makes in production. Add that `role` must never ride along in that payload.

Three places repeat the stale claim that the auto-DJ account leaves `user.role` null; it lands on `'user'`. Correct all three: `CLAUDE.md:117` (highest-traffic copy), `apps/auth/create-auto-dj-user.ts:28` and `:76`.

`scripts/check-auth-tables-doc.mjs` needs no change — it extracts `pgTable('auth_…')` name literals via `PG_TABLE_RE` (`:108`).

### 8. Orphan membership — folded in from the #1223 review

Carried in at the user's direction rather than filed separately. A user with no `auth_member` row folds into `"member"` and renders in the dj-site roster as an ordinary Member; a station manager who tries to correct that hits `AccountEditForm`'s `resolveMemberId` throwing _"User is not a member of the organization"_ — a dead end with no on-screen explanation.

Latent today (110 users / 110 membership rows / zero orphans) but no longer purely hypothetical: §5 now _detects_ orphans and deliberately declines to act on them, so the state becomes reachable and observable rather than silently reconciled.

- **Backend-Service (this work).** §5's Sentry report is the detection. §3's fail-closed payload means an orphan gets a 403 rather than a plausible-looking Member token.
- **dj-site (chained follow-up PR, referencing this issue).** A distinct "no membership" affordance instead of rendering as Member, and an explanation on `resolveMemberId`'s failure. Deferred from #1223 because the fix means adding a display state to `Authorization`, a shared enum in `@wxyc/shared` consumed by other repos — that widening is the real design question and belongs in its own review.

## Tests

| #   | Test                                                                                                                                                                           | File                                                       | Tier               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------ |
| 1   | `buildJwtPayload` omits `role` when `fetchMemberRole` throws                                                                                                                   | `tests/unit/authentication/jwt-payload.test.ts`            | unit               |
| 2   | `buildJwtPayload` omits `role` when membership returns empty                                                                                                                   | same                                                       | unit               |
| 3   | `buildJwtPayload` emits `member.role` on the happy path                                                                                                                        | same                                                       | unit               |
| 3b  | **the fallback still carries `banned` and `banReason`** — `role` is dropped by destructure, not by narrowing                                                                   | same                                                       | unit               |
| 4   | admin plugin declares `defaultRole`, `adminRoles`, `roles`                                                                                                                     | `tests/unit/authentication/admin-plugin-config.test.ts`    | unit (source-scan) |
| 5   | `syncAdminRoles` demotes to **`null`** when the membership row exists and is not admin-ish                                                                                     | `tests/unit/auth/sync-admin-roles.test.ts`                 | unit               |
| 6   | `syncAdminRoles` does **not** demote when the membership row is absent — reports instead                                                                                       | same                                                       | unit               |
| 7   | `syncAdminRoles` still promotes; no-ops when `DEFAULT_ORG_SLUG` unset; all four §4 sites call `onError`                                                                        | same + `tests/unit/authentication/admin-flag-sync.test.ts` | unit               |
| 8   | CHECK rejects `UPDATE auth_user SET role='musicDirector'`                                                                                                                      | `tests/integration/auth-user-role-constraint.spec.js`      | integration        |
| 9   | `/admin/create-user` with no `role`, and `/sign-in/anonymous`, both land on `role='user'`                                                                                      | same                                                       | integration        |
| 10  | `provisionUser({role:'stationManager'})` still yields `user.role='admin'`                                                                                                      | same                                                       | integration        |
| 11  | schema/migration coupling                                                                                                                                                      | `tests/unit/database/schema.auth-user-role.test.ts`        | unit               |
| 12  | `assertScalarRoleWrite` throws 400 for array-valued and comma-bearing `role` on all three `/admin/*` write paths; returns silently for a scalar `role` and for unrelated paths | `tests/unit/authentication/admin-role-write-guard.test.ts` | unit               |

Test 12 pins the §2 request guard — the specific path that would otherwise surface as an unhandled 23514. It is a **unit** test, not an integration test, because §0 extracts the policy into a pure function; `APIError` is already stubbed at `tests/mocks/better-auth-api.mock.ts:4`, so the assertion is `rejects.toMatchObject({ body: … })` exactly as in `device-authorization.test.ts:32`. That also lets it cover all three paths and both malformed shapes cheaply, which an integration test against a live admin session would not.

Test 9 was retargeted in r4: `disableSignUp: true` (`auth.definition.ts:97`) means there is no ordinary email signup. `/admin/create-user` with no role is already exercised at `tests/integration/auth-auto-membership.spec.js:104`.

Unit tests 1–3b, 5–7 and 12 import the extracted modules **by relative path** with callbacks injected, mirroring `tests/unit/authentication/device-authorization.test.ts`. Tiers split by owning workspace — `shared/authentication` code tests in `tests/unit/authentication/`, `apps/auth` code tests in `tests/unit/auth/`.

Integration tests are CommonJS `.js` (`jest.config.json` `testMatch: **/tests/integration/?(*.)+(spec).js`), modelled on `tests/integration/auth-auto-membership.spec.js`, and need the docker DB, which picks up the new migration via the `dev_env/docker-compose.yml:54` bind mount.

Test 11 follows the 31 sibling `tests/unit/database/schema.*.test.ts` files: read schema.ts and the migration SQL **as text**, locate the migration by `tag.startsWith('0150_')` out of `meta/_journal.json`, and assert the journal entry exists, its `when` exceeds `0149_`'s, the `check('auth_user_role_system_only', …)` declaration is present, and the SQL contains both the `UPDATE` and the `ADD CONSTRAINT`.

## Verification

Acceptance criterion: _station managers retain working `/admin/*` access — verified against the 8 existing ones._

Pre-deploy, the ticket's role cross-tab is the baseline. Post-deploy, re-run it and confirm the `admin`/`stationManager` cell is still 8 and the `dj`/`dj` cell has moved to `user`/`dj`. Read-only, through the authenticated HTTP API — the Safari authed-probe technique (`osascript` + in-page `fetch`), not direct DB access, which is permission-gated. Needs a `!`-prefixed command from the user if a live probe is wanted.

## Risks

| Risk                                                              | Severity | Mitigation                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constraint rejects a user-creation path we missed                 | **high** | Inventory now covers all four `/admin/*` writers, `anonymous()`, `provisionUser`, and `dev_env/seed_db.sql` (verified in-alphabet); no ordinary signup exists; test 9; `migrate-dryrun` against prod-shaped data |
| Array/comma `role` on an `/admin/*` write → unhandled 23514 (500) | **high** | §2's request guard is the actual fix; the `roles` pin alone does not close it; test 12                                                                                                                           |
| Demotion branch strips a legitimate admin                         | medium   | §5's join-succeeds restriction; test 6; `DEFAULT_ORG_SLUG` guard retained                                                                                                                                        |
| better-auth upgrade changes `defaultRole`                         | medium   | §2 pin + test 4                                                                                                                                                                                                  |
| Fail-closed JWT 403s an SM on a transient error                   | medium   | ≤15 min (token TTL), permission-declaring routes only, both clients already degrade gracefully; Sentry capture; flagged for override                                                                             |
| §0 extraction changes behavior while moving it                    | medium   | Isolated into its own PR whose sole acceptance criterion is a green suite                                                                                                                                        |
| Shape-probe failure misread as a blocker                          | low      | Paren-free predicate + expected-failure note in §1 and the PR body                                                                                                                                               |
| Journal `when` collision with a parallel PR                       | low      | Re-check tail at merge; no `0150_` in any sibling worktree today                                                                                                                                                 |

## Sequencing — two chained PRs

Split per the ≤1000-line PR guidance. §0 is a pure behavior-preserving move whose acceptance criterion is exactly "the existing suite stays green," which also isolates the extraction risk from the behavior changes.

**PR 1 — extraction only.** Branch `fix/2171-extract-auth-role-helpers`. §0: four new modules with deps injected, call sites rewired, no barrel entries. No behavior change; the existing suite must pass untouched. Body notes it is a prerequisite for #2171 and closes nothing.

The fourth module (`admin-role-write-guard.ts`) is the one exception to "behavior-preserving": there is no existing guard to move, so PR 1 lands it _unwired_ alongside test 12, and PR 2 calls it from the `hooks.before` middleware. That keeps PR 1's acceptance criterion intact while still getting the guard reviewed as a pure function rather than buried in PR 2's diff.

**PR 2 — behavior + schema.** Branch `fix/2171-narrow-auth-user-role` (this worktree), rebased on PR 1.

1. Tests 1–7 (unit + integration, red) → §2, §3, §4, §5 → green. Test 12 already exists from PR 1; §2 wires the guard in.
2. Test 11 + tests 8–10 (red) → §1 schema + `drizzle:generate` → green. Paste the emitted DDL into this plan and the PR body. `migrate-dryrun` is the real gate.
3. §6, §7, §8 — script narrowing, doc amendments, stale-claim corrections in all three places.
4. Local CI parity (`npm run lint`, `format:check`, `typecheck`, `build`, `test:unit`, `ci:testmock`) before any push.
5. `Closes #2171`. File the chained dj-site follow-up from §8, and the `schema-shape-report.mjs` follow-up from §1 (ask first — separate defect).

## Out of scope

- Any write to `auth_member.role` — the ticket forbids it, and it is correct today.
- Adding `admin` to `WXYCRoles` or `ROLES` — `systemRoleMap` already maps `admin`/`owner` → `stationManager`.
- The `Authorization` enum widening in `@wxyc/shared` that a full dj-site orphan affordance needs (§8).
- Reconciling `CLAUDE.md:199-205`'s documented branch prefixes (`feature/`, `task/`, `bugfix/`) with the de-facto `fix/` in use here and in `.worktrees/1748-bound-lml-limiter-queue`. Real drift, unrelated to this ticket.
