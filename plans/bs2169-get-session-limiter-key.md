# BS#2169 — Take `/auth/get-session` off IP-keyed rate limiting

Issue: https://github.com/WXYC/Backend-Service/issues/2169
Companion: https://github.com/WXYC/dj-site/issues/1225 (independent; neither blocks the other)
Branch: `fix/bs2169-get-session-limiter-key`

## Problem

`GET /auth/get-session` 429s in bursts (2,128 on Aug 13 = 14.1% of that day's requests), and the user-visible result is a silent logout for DJs on dj-site rather than a throttle. Two compounding causes, both re-verified against the installed `better-auth@1.6.26` during planning:

1. **better-auth's limiter is not a fixed window.** It resets on time since the _last allowed_ request, so any caller polling faster than once per 10 s accumulates monotonically to `max: 100` and then 429s regardless of rate.
2. **The IP in the key has no discriminating power.** 100% of `/auth/get-session` traffic arrives from Cloudflare egress IPs, so the whole DJ population shares ~10 buckets of 100.

The issue body has the full production evidence (nginx + Sentry, cross-checked). This plan does not restate it; it records what planning _verified in source_, what it _corrected_, and what to build.

## Verified during planning

Cite these when reviewing — they are the load-bearing facts.

**Where to reproduce them.** This worktree has no `node_modules`; these were read from the primary checkout at `/Users/jake/Developer/WXYC/Backend-Service/node_modules`. Line numbers point into a _built, minified upstream artifact_ that any version bump reshuffles, so treat the **symbol names** (`resolveRateLimitConfig`, `decideConsume`, `getRateLimitStorage`, `normalizePathname`, `getIp`, `createRateLimitKey`) plus the pinned version (`better-auth@1.6.26`, via `^1.6.26` in all three package.jsons) as the durable reference and the line numbers as a convenience that will rot.

### `customRules` accepts `false` and short-circuits correctly

`node_modules/better-auth/dist/api/rate-limiter/index.mjs:301-320` (`resolveRateLimitConfig`):

```js
if (ctx.rateLimit.customRules) {
  const _path = Object.keys(ctx.rateLimit.customRules).find((p) => {
    if (p.includes("*")) return wildcardMatch(p)(path);
    return p === path;                       // exact match otherwise
  });
  if (_path) {
    const customRule = ctx.rateLimit.customRules[_path];
    const resolved = typeof customRule === "function" ? await customRule(...) : customRule;
    if (resolved) { currentWindow = resolved.window; currentMax = resolved.max; }
    if (resolved === false) return null;     // <- storage never touched
  }
}
```

`onRequestRateLimit` returns immediately on a `null` config (`:337-338`). The rule key is **`/get-session`**, not `/auth/get-session` — `normalizePathname` (`@better-auth/core/dist/utils/url.mjs:18-30`) strips the `/auth` basePath before matching.

Note the ordering: `if (resolved)` runs _before_ the `=== false` check. `false` is falsy so the first branch is skipped and the second returns — correct today, but it is an implementation detail of a minified upstream build. **Pin it with a test** (see Testing) so a `better-auth` bump that reorders those two lines fails CI rather than silently re-enabling IP keying.

### The never-resets-while-busy semantics, and _why_ recovery is bounded

`decideConsume` (`:26-61`) resets on `now - data.lastRequest > windowInMs` and bumps `lastRequest` only on the allowed branch. The denied branch returns `next: data` **unchanged**.

The installed version reaches the same outcome by a second route the issue does not mention: the memory store now carries an `expiresAt` TTL, and `consume` only writes it back when allowed (`:251-268`):

```js
if (decision.allowed) memory.set(key, { data: { ...decision.next, key }, expiresAt: now + ttlFor(rule.window) * 1e3 });
```

Both paths converge on ~10 s from the last _allowed_ request. **The duty-cycle analysis in the issue holds.** This matters for the companion dj-site issue: a client retry during a burst does not reset the clock, so retrying a 429 at 1–2 s will just 429 again.

### CORRECTION — the "silently disables its internal rate limiter" comment is stale

`apps/auth/app.ts` (the `/healthcheck` handler, ~line 424) states that an unresolvable client IP latches a warning which "silently disables its internal rate limiter for the rest of the process lifetime." That was true when #765 was written. **It is not true at `better-auth@1.6.26`.** The string `Rate limiting skipped` does not exist anywhere in the installed package.

Current behavior (`index.mjs:272-285`):

```js
const NO_TRUSTED_IP_KEY = "no-trusted-ip";
...
if (!ip && ctx.options.advanced?.ipAddress?.disableIpTracking) return null;
if (!ip && !ipWarningLogged) { ctx.logger.warn("...falling back to a single shared per-path bucket..."); ipWarningLogged = true; }
const key = createRateLimitKey(ip ?? NO_TRUSTED_IP_KEY, path);
```

An IP-less caller is now bucketed into **one shared per-path bucket**; the latch applies only to the log line. That is strictly worse than "disabled" for our purposes, and it means both layers (better-auth's `no-trusted-ip` and our own `rateLimitKeyFromRequest`'s `'unknown'`) now fail into a single shared bucket. Fix the comment and add the guard in this PR.

The healthcheck's `X-Real-IP: 127.0.0.1` is still required and still correct — it just prevents a different failure than the comment claims.

### The internal limiter is production-only

`node_modules/better-auth/dist/.../create-context.mjs:169-175`:

```js
rateLimit: {
  ...options.rateLimit,
  enabled: options.rateLimit?.enabled ?? isProduction,
  window: options.rateLimit?.window || 10,
  max:    options.rateLimit?.max    || 100,
  storage: options.rateLimit?.storage || (options.secondaryStorage ? "secondary-storage" : "memory"),
},
```

Two consequences:

- Adding a `rateLimit: { customRules: ... }` block to `auth.definition.ts` is **safe**: `window`/`max`/`storage` keep their defaults and `enabled` keeps its `?? isProduction` resolution. We are not turning anything on.
- **This bug is structurally invisible outside production.** `enabled` is false under `NODE_ENV=test`, and `getIp` additionally returns `LOCALHOST_IP` in test/dev (`@better-auth/core/dist/utils/ip.mjs:210-217`). No integration test can reproduce the 429. Tests must target the pure key/config functions — see Testing.

### There is no `cookie-parser` in the auth app

`apps/auth/app.ts` mounts `express.json()` and `cors()` only. **`req.cookies` is `undefined`.** The new key generator must parse the `Cookie` header itself. Do _not_ add `cookie-parser` for this — it would parse cookies on every request to the auth service to serve one route's key function.

### `apps/auth` already ships an AWS SDK and already reads `AWS_REGION` — and that changes the IAM question

An earlier draft of this plan asserted the opposite, from a grep of `apps/*/package.json` for `@aws-sdk/client-cloudwatch`. That missed the transitive path: **`@aws-sdk/client-ses` is a dependency of `shared/authentication` (`package.json:22`)**, which ships into the auth image, and `shared/authentication/src/email.ts:10-21` reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` — all three already documented at `docs/env-vars.md:66`. So there is no new env var to document and no first AWS SDK to introduce.

**The consequence is not cosmetic.** `email.ts` builds its `SESClient` with _explicit_ env-var credentials, but the CloudWatch precedent (`apps/backend/middleware/responseMetrics.ts:52-54`) constructs `new CloudWatchClient({ region })` with **no** credentials, falling back to the AWS default provider chain — and that chain resolves **environment-variable credentials before the EC2 instance role**. Both containers are started with the same `--env-file .env` (`.github/workflows/deploy-base.yml:723`), which carries the SES keys. So the emitter would authenticate as the **SES IAM user**, not the instance role.

This inverts the pre-flight in Risks. The question is not "does the instance role have `cloudwatch:PutMetricData`" but **"does the principal behind `AWS_ACCESS_KEY_ID` in the host `.env` have it?"** — and there is a strong prior that it does: `apps/backend`'s `MutationClientError` emitter uses the identical credential-free pattern under the identical env file, so if that metric is landing in prod today, the permission is already there. Confirm it before wiring; don't assume the instance role.

## Decisions (locked)

| Decision          | Choice                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Fairness key      | `bearer:` / `session:` `<sha256(credential).slice(0,16)>`, falling back to `ip:<x-real-ip>` |
| Fairness budget   | `windowMs: 60_000`, `limit: 120` (a real fixed window, unlike better-auth's)                |
| **Abuse ceiling** | **a second, IP-keyed limiter layered on the same path: `windowMs: 60_000`, `limit: 600`**   |
| Observability     | CloudWatch dimensioned + dimensionless companion, **and** a Sentry breadcrumb               |

Rationale for the key shape: it mirrors `apps/backend/middleware/rate-limit-key.ts` (BS#1127), whose namespacing exists precisely so one key space cannot poison another. Hash rather than store the raw credential — it is live, and express-rate-limit keys surface in logs and error paths. 120/min is far above any human navigation rate (dj-site's SSR reads dedup through React `cache()` to ~1 `getSession` per navigation) while still bounding a stolen-credential replay.

### Why the second limiter is not optional

**The cookie and bearer token are unverified at `keyGenerator` time.** Express runs the key function long before better-auth validates anything, so a caller sending a fresh random `Authorization: Bearer <nonce>` on every request mints a brand-new bucket every request and is _never_ throttled — while each request still costs the auth service a DB session lookup. Taken alone, step 1 + the identity key would therefore be a **net security regression**: it removes the only DoS bound (`better-auth`'s IP bucket) from a DB-touching endpoint and replaces it with one an attacker can trivially sidestep.

The BS#1127 precedent this plan cites keys on `req.auth.id` — a _verified_ identity resolved by upstream middleware. We have no equivalent here, so identity keying buys fairness but cannot carry the abuse bound. The two concerns need two limiters:

- **Identity-keyed, 120/min** — fairness. Each DJ gets their own budget; one DJ cannot exhaust another's. This is the fix for the actual reported bug.
- **IP-keyed, 600/min** — abuse ceiling. Bounds fabricated-credential floods and preserves a DoS bound on the DB lookup.

600/min per Cloudflare egress IP does not reintroduce the original defect. That defect was not the number 100 — it was better-auth's _never-resets-while-busy_ semantics (a continuously-active key accumulates monotonically and can never clear). express-rate-limit is a true fixed window that resets unconditionally every 60 s. Against observed traffic — get-session runs to low thousands/day org-wide, single-digit requests/minute across ~10 edges — 600/min/edge is roughly two orders of magnitude of headroom.

**Size the cookie-less arm deliberately: its binding limit is 120/min per edge, not 600.** When a request carries neither cookie nor bearer, `sessionRateLimitKeyFromRequest` falls back to the Cloudflare edge IP and the ceiling keys on the same value — so both limiters bucket that traffic identically and the _tighter_ one wins. Anonymous `GET /auth/get-session` (signed-out SSR, pre-cookie cold loads) therefore shares 120/min/edge, which is structurally the same shared bucket the fix exists to eliminate, just with a larger number. Against the observed volume that is still ~100× headroom, so it is acceptable — but it is a real ceiling and must be stated rather than discovered. AC3 requires the IP fallback, so skipping the identity limiter on credential-less requests is _not_ an option; if this arm ever gets tight, raise its limit rather than removing the fallback.

State this layering and its ceiling explicitly in the code comments; a future reader who sees two limiters on one path must not "simplify" one away.

## Implementation

### 1. Disable better-auth's rule for `/get-session`

`shared/authentication/src/auth.definition.ts` — add a top-level `rateLimit` block:

```ts
rateLimit: {
  // BS#2169. better-auth keys its internal limiter on `${ip}|${path}`, and
  // 100% of /auth/get-session traffic reaches us from Cloudflare egress IPs
  // (dj-site's SSR arm is an edge-side fetch carrying only a cookie), so the
  // entire DJ population shares ~10 buckets. Worse, the limiter resets on time
  // since the last ALLOWED request, so a continuously-active key accumulates to
  // `max` and 429s regardless of rate. Express owns this path instead, keyed on
  // the session cookie — see apps/auth/rate-limit-key.ts.
  //
  // The key is `/get-session`, not `/auth/get-session`: normalizePathname
  // strips the basePath before matching. `false` short-circuits
  // resolveRateLimitConfig before storage is touched.
  //
  // This block does NOT enable rate limiting or change window/max — those keep
  // their create-context defaults (`enabled: ?? isProduction`, 10s/100).
  customRules: {
    '/get-session': false,
  },
},
```

Leave `/token` and `/sign-in*` untouched. They stay IP-keyed by design (issue Constraints).

### 2. Add a session-cookie key generator

`apps/auth/rate-limit-key.ts` — keep the existing export unchanged, add:

- `SESSION_COOKIE_NAMES = ['__Secure-better-auth.session_token', 'better-auth.session_token']`. Both are needed: `auth.definition.ts` sets `advanced.defaultCookieAttributes.secure = NODE_ENV === 'production'`, and better-auth prefixes with `__Secure-` only when `secure` is set. No `cookiePrefix` override exists, so the `better-auth` default prefix holds.
- A minimal `Cookie`-header scan for those names (split on `;`, trim, match up to the first `=`). Check `__Secure-` first.
- `sessionRateLimitKeyFromRequest(req)`, in precedence order:
  - **`Authorization: Bearer <token>`** present → `` `bearer:${sha256(token).slice(0, 16)}` ``
  - session cookie present → `` `session:${sha256(value).slice(0, 16)}` ``
  - neither → `` `ip:${clientIp}` `` reusing the existing `x-real-ip` → `socket.remoteAddress` resolution.

**The bearer arm is not optional.** `bearer()` is registered at `auth.definition.ts:206` and `GET /get-session` is exercised with an `Authorization: Bearer` token by `tests/integration/device-authorization.spec.js:280`. A cookie-only key would leave exactly the device/iOS arm sharing the ~10 Cloudflare buckets this fix exists to eliminate. Same hash rationale as the cookie: the token is a live credential and must not become a log-visible key.

**Deliberately NOT in this PR: the `'unknown'` fallback.** The issue suggests fixing it "while you are here." Don't. `rateLimitKeyFromRequest` is the `keyGenerator` for _both_ existing limiters (`app.ts:343` sign-in/sign-up/device, `:389` check-request-ban) and is pinned by `tests/unit/auth/rate-limit-key.test.ts:29` — changing it silently rekeys the brute-force limiters, which is a different blast radius than this change and directly conflicts with the AC2 constraint that their bucketing stay unchanged. It also cannot fire today (nginx always sets the header). File it as its own issue, specifying the replacement value and a one-shot log latch (better-auth latches its own equivalent warning at `index.mjs:280` for flood reasons).

Note `apps/backend/middleware/rate-limit-key.ts` duplicates the IP resolution with its own `user:`/`ip:` prefixes. Do **not** try to unify them in this PR — the backend one keys on `req.auth.id`, which the auth service does not have. Cross-reference them in comments instead.

### 3. Mount the express limiter

`apps/auth/app.ts`, inside the existing `if (!isTestEnv)` block, **before** `app.use('/auth', toNodeHandler(auth))`:

Two limiters, mounted in order — see "Why the second limiter is not optional".

```ts
const sharedOpts = {
  windowMs: 60_000,
  legacyHeaders: false,
  // Preserve the body shape both existing auth limiters use (app.ts:342, :388)
  // so dj-site sees one 429 shape across every auth route.
  message: { error: 'Too many requests, please try again later.' },
};

// Abuse ceiling: bounds fabricated-credential floods, which the identity key
// below cannot (neither the cookie nor the bearer token is verified here).
// standardHeaders is off: this is an invisible backstop, not a client contract,
// and two co-mounted limiters would otherwise fight over the draft-7 headers.
// NOTE: rateLimitKeyFromRequest returns a BARE ip with no namespace prefix,
// unlike sessionRateLimitKeyFromRequest's `ip:` arm. Separate stores, so no
// poisoning — but the two `ip`-shaped key spaces are NOT the same one.
const getSessionIpRateLimit = rateLimit({
  ...sharedOpts,
  limit: 600,
  standardHeaders: false,
  keyGenerator: rateLimitKeyFromRequest,
  handler: makeHandler('ip'),
});

// Fairness: each DJ gets their own budget (BS#2169). This one owns the
// client-facing RateLimit headers.
const getSessionIdentityRateLimit = rateLimit({
  ...sharedOpts,
  limit: 120,
  standardHeaders: 'draft-7',
  keyGenerator: sessionRateLimitKeyFromRequest,
  handler: makeHandler('identity'),
});

app.use('/auth/get-session', getSessionIpRateLimit, getSessionIdentityRateLimit);
```

**Why `standardHeaders` differs between them.** express-rate-limit 8.6.2 writes the draft-7 `RateLimit` / `RateLimit-Policy` headers unconditionally per limiter (`dist/index.mjs:938-943`), so if both advertised draft-7 the identity limiter's 120 would overwrite the ceiling's 600 and a client rejected by the ceiling would be told its budget is 120. Both also default to `requestPropertyName: 'rateLimit'` (`:784`), so `req.rateLimit` would reflect only whichever ran last. Turning headers off on the invisible backstop resolves both. (The alternative is draft-8 with distinct `identifier` and `requestPropertyName` values; simpler is better here.)

**The custom `handler` must send the body itself.** express-rate-limit sends `options.message` only from its _default_ handler; supplying a custom one replaces that path entirely. Both existing auth limiters (`app.ts:342`, `:388`) rely on the default, so `makeHandler` must end with `res.status(options.statusCode).json(options.message)` or the "one 429 shape across every auth route" goal silently fails. **Decision: use the custom handler** rather than an `res.on('finish')` hook — it keeps the metric adjacent to the rejection decision and lets the two limiters tag their datums (`ip` vs `identity`) without inferring which one fired.

`app.use(path, ...)` is a prefix match, but `/auth/get-session` has no sub-paths, so there is nothing to shadow. (Contrast the `/auth/device` case documented in the existing `rateLimitedPaths` comment.)

### 4. Observability

**Extract, don't copy.** `shared/observability` (`@wxyc/observability`, BS#2089) exists precisely so both containers share observability code. It is already a dependency of `apps/auth`, already built and copied in `Dockerfile.auth:24,30`, and already source-mapped in `jest.unit.config.ts:29`. A third copy of the buffer/flush/emit-twice machinery is the wrong move.

Add a generic buffered CloudWatch emitter to `@wxyc/observability`, parameterized by namespace, metric name, and dimension set — the machinery currently duplicated between `apps/backend/middleware/responseMetrics.ts` (BS#845) and `apps/backend/services/sse/sse-metrics.ts`. Consume it from `apps/auth` only in this PR; **migrating those two existing backend emitters onto it is a follow-up**, kept out of scope to hold this PR near the 1000-line guideline.

**Ship it as a subpath entry — `@wxyc/observability/metrics` — never from the barrel.** `shared/observability/src/index.ts` is a one-line barrel and the package's only tsup entry (`tsup.config.ts:4`). Both `apps/auth/instrument.ts:3` and `apps/backend/instrument.ts:3` import from that barrel, and instrument is loaded via `node --import ./dist/instrument.js` (see each app's `start` script). Re-exporting an AWS-SDK-backed emitter from the barrel would **eagerly load `@aws-sdk/client-cloudwatch` at process preload in both images**, and tsup would bundle the entire SDK into `dist` unless it is externalized. (`jest.unit.config.ts:29` maps the barrel to source.) So:

- add `src/metrics.ts` to the tsup `entry` array,
- add a matching `./metrics` key to the package `exports` map,
- add `@aws-sdk/client-cloudwatch` to tsup's `external` list (currently `['@sentry/core', '@sentry/node']`),
- **add `'^@wxyc/observability/metrics$': '<rootDir>/shared/observability/src/metrics.ts'` to `jest.unit.config.ts`.** The existing mapping at line 29 is `'^@wxyc/observability$'` — anchored and exact, so the subpath will not match it. Without this, the new tests (and any `apps/auth` module importing the subpath) fall through to node resolution against `shared/observability/dist`, which CI's unit-tests job never builds — that is the stated reason the source mappings exist at all.
- **add a matching `paths` entry in `tests/tsconfig.json:16-19` (and consider `tsconfig.base.json:29`, which today maps only the bare specifier).** The moduleNameMapper fixes Jest's _runtime_ resolution only; ts-jest compiles against `tests/tsconfig.json:5`, which sets `"moduleResolution": "Node"` — node10, which ignores `exports` maps entirely. The existing bare `@wxyc/observability` import (`tests/unit/config/sentry-transaction-filter.test.ts:4`) survives node10 only because the package has a top-level `"types": "dist/index.d.ts"` (`shared/observability/package.json:29`); a subpath has no equivalent fallback and there is no `shared/observability/metrics.d.ts`. **Verify with a real `npm run test:unit` before committing** — this is the kind of resolution gap that type-checks in the editor and fails in CI.

`Dockerfile.auth:26` already copies `shared/observability/package*` before `npm install --omit=dev` (line 28), so **no Dockerfile change is needed** — stated here so it isn't re-litigated during implementation.

Behavior to preserve from the precedents:

- Namespace `WXYC/AuthService`, metric `RateLimited`.
- **Emit dimensioned only for now** (`Limiter` ∈ `ip` | `identity`, `KeyKind` ∈ `session` | `bearer` | `ip`, `Route` = `/auth/get-session`). See the companion decision below.
- Buffered flush — whichever comes first, 30 s or N buffered — so a sustained burst does not become a `PutMetricData` storm.
- `AUTH_RATE_LIMIT_METRICS_DISABLED=true` opt-out so CI and local dev never reach for CloudWatch.
- Swallow `PutMetricData` rejections; never block the response.
- Plus `Sentry.addBreadcrumb({ category: 'auth.ratelimit', ... })` in the handler. **A breadcrumb, not `captureMessage`/`captureException`** — a per-request Sentry event on a rate-limit path is exactly the flood PR #691 and the org's Sentry-quota history argue against.

File placement follows `apps/auth`'s flat layout — **`apps/auth/auth-rate-limit-metrics.ts`, not `apps/auth/middleware/`.** All 16 source files there are flat, and their tests live in `tests/unit/auth/`.

Add `@aws-sdk/client-cloudwatch` to `shared/observability/package.json` (and to `apps/auth` only if it imports the SDK types directly), matching the version in `apps/backend/package.json`.

**Decision on the dimensionless companion: don't ship it yet.** `WXYC/CLAUDE.md` is explicit that a companion is for alarm inputs only — it doubles cost, pollutes the namespace, and invites a future misconfigured alarm. AC4 is verified by the nginx `zcat` grep, not by an alarm, so today the companion would have no consumer. The in-repo precedent agrees: `sse-metrics.ts` ships `EventsBroadcast` dimensioned-only for exactly this reason, and adds the companion only for `BroadcastFailures` / `InsertSuppressed`, which do have alarms.

So: **emit dimensioned-only in this PR, file the `wxyc-canary` alarm issue for `WXYC/AuthService RateLimited` as a follow-up, and add the companion when that alarm lands** — the order `MutationClientError` and wxyc-canary#17 followed.

### 5. Document the new configuration and the package's widened remit

- `docs/env-vars.md` documents the sibling `MUTATION_4XX_METRICS_DISABLED` at line 10. Add `AUTH_RATE_LIMIT_METRICS_DISABLED` under the `## better-auth (apps/auth)` section (line 46). **No `AWS_REGION` task** — `apps/auth` already reads it via `shared/authentication/src/email.ts` and it is documented at `docs/env-vars.md:66`.
- Update `shared/observability/package.json`'s `description` — it currently reads "Shared Sentry transaction/span filter predicates (BS#2089)", and this PR widens the package into a cross-container metrics emitter.
- Pin `@aws-sdk/client-cloudwatch` to `^3.1106.0`, matching `apps/backend/package.json:19`.
- Add (or extend) the `@wxyc/observability` row in CLAUDE.md's Monorepo Layout table — the package is absent from it today, and the repo's Doc hygiene section calls for a CLAUDE.md update when a cross-cutting pattern is introduced.

### 6. Correct the stale comment

`apps/auth/app.ts` `/healthcheck` handler — rewrite the `X-Real-IP: 127.0.0.1` rationale per the CORRECTION above. Keep the header; fix the stated reason and cite BS#2169.

## Testing

`NODE_ENV=test` disables both limiters (`isTestEnv` in `app.ts`, `enabled ?? isProduction` in better-auth), so **an integration test cannot observe this behavior.** Test the pure functions and the config object.

**Order: test-first.** Tests 1–7 (the pure key function) are written before step 2, and test 8 (the `customRules` source pin) before step 1. Both source-text assertions (8 and 9) must be **observed failing against the pre-change source** — a `readFileSync` + regex test that was never seen red is indistinguishable from one whose regex doesn't match anything.

New `tests/unit/auth/session-rate-limit-key.test.ts`:

1. `__Secure-`-prefixed cookie present → `session:` key; same cookie twice → identical key; different cookies → different keys.
2. Unprefixed `better-auth.session_token` (non-prod cookie shape) → also matches.
3. `Authorization: Bearer <token>` present → `bearer:` key, and it takes precedence over a cookie when both are present.
4. No session cookie, no bearer, `x-real-ip` set → `ip:<addr>`.
5. No session cookie, no bearer, no `x-real-ip` → socket fallback.
6. **The raw cookie value and raw bearer token never appear in the key** — regression guard against putting a live credential into a log-visible key.
7. Cookie header containing other cookies around the session one, and a value containing `=` (base64 signature), parse correctly.

Leave `tests/unit/auth/rate-limit-key.test.ts` untouched — the `'unknown'` change is scoped out (step 2).

**Config pinning (AC2 — "`/auth/token` and `/auth/sign-in*` bucketing are unchanged"): assert over source text, not by import.** `@wxyc/authentication` is moduleNameMapped to `tests/mocks/authentication.mock.ts` (`jest.unit.config.ts:20`), and importing `shared/authentication/src/auth.definition.ts` directly pulls in `better-auth`, `better-auth/adapters/drizzle`, `better-auth/cookies` and `better-auth/plugins` — ESM subpaths that are neither mapped nor in `transformIgnorePatterns` (only `/node`, `/api`, `/plugins/access`, `/plugins/organization/access` are mocked). An import-based test cannot run.

Every existing config assertion in this repo already uses `readFileSync` + regex over the source: `tests/unit/authentication/cookie-config.test.ts`, `session-config.test.ts`, `oidc-provider-schema.test.ts`, `tests/unit/config/auth-healthcheck-ip-header.test.ts`. Follow that idiom.

8. In `tests/unit/authentication/`, read `auth.definition.ts` and assert `customRules` contains `'/get-session': false` and no key matching `/token` or `/sign-in`. The tripwire for a `better-auth` bump reordering the `resolved` checks, and for someone widening `customRules` later.

   **Scope the negative assertion to the `customRules` object literal.** Asserting over the whole file will false-fail on day one: `/auth/token` appears at line 75, `sign-in` at 390 and 436, and `ctx.path === '/device/token'` at 504 — all unrelated. Capture `customRules:\s*\{[\s\S]*?\}` first and assert over the capture.

9. **Extend `tests/unit/auth/rate-limiting.test.ts`** (do not create a new file — `:4-28` already does exactly this: `readFileSync` over `apps/auth/app.ts` plus regex assertions on limiter names and mounted paths). Add assertions that **both** `getSessionIpRateLimit` and `getSessionIdentityRateLimit` are mounted on `/auth/get-session`. The abuse ceiling is the whole reason removing better-auth's IP bucket is safe; a future "simplification" that drops it must fail CI, and since `isTestEnv` disables the mounted middleware, source-text assertion is the only way to pin it.

Metrics tests split by ownership, since the emitter is shared and only its wiring is auth-specific:

- **`tests/unit/observability/`** — generic emitter behavior: buffering, flush-on-interval vs flush-on-size, coalescing, and that a rejected `PutMetricData` is swallowed rather than thrown. (`tests/unit/shared/{database,lml-client,metadata}/` is the existing precedent for package-scoped tests.) Mirror `tests/unit/middleware/responseMetrics.test.ts` for these cases.
- **`tests/unit/auth/auth-rate-limit-metrics.test.ts`** — auth wiring only: namespace, metric name, dimension set, and the `AUTH_RATE_LIMIT_METRICS_DISABLED` short-circuit.

**Assert the _absence_ of the dimensionless companion.** The decision in step 4 is dimensioned-only until the canary alarm lands, so the test must assert exactly one `MetricDatum` per coalesced entry and **no** empty-`Dimensions` datum. Written the other way round it fails on day one — and this way the follow-up alarm PR has to consciously flip it.

## Acceptance criteria (from the issue)

- [ ] `/auth/get-session` no longer bucketed by `x-real-ip` for cookie-bearing requests — steps 1+2+3
- [ ] `/auth/token` and `/auth/sign-in*` unchanged, pinned by a test — test 8
- [ ] Cookie-less request still falls back to IP bucketing — tests 4, 5
- [ ] `GET /auth` 429 rate under 0.1% over 7 days post-deploy — **verify after deploy**, see below
- [ ] The limiter emits something observable — step 4

Follow-ups this PR should file rather than absorb:

- The `'unknown'` fallback in `apps/auth/rate-limit-key.ts` (blast radius: both existing limiters).
- A `wxyc-canary` alarm on `WXYC/AuthService RateLimited`, so the dimensionless companion has a consumer.
- Migrating `responseMetrics.ts` and `sse-metrics.ts` onto the extracted `@wxyc/observability` emitter.

## Post-deploy verification

AC4 is measured, not implemented. After deploy, re-run the issue's own command on the EC2 host and compare against the 4.5% month-average / 14.1% worst-day baseline:

```
sudo zcat /var/log/nginx/access.log-*.gz | awk '$9==429 {print $7}' | sort | uniq -c | sort -rn
```

**logrotate names files by rotation date** — `access.log-20260814.gz` holds Aug 13 traffic. An off-by-one here will make the numbers disagree with Sentry.

Cross-check against the new `WXYC/AuthService` `RateLimited` metric; the two should agree once the metric has a full window of data.

## Risks and open items

- **The metric will authenticate as the SES IAM user, not the instance role.** Per "Verified during planning", the emitter follows `responseMetrics.ts` in omitting explicit credentials, and the AWS default chain prefers the `AWS_ACCESS_KEY_ID` env vars (present in both containers' shared `--env-file .env`) over the EC2 instance role. **Pre-flight: confirm that principal has `cloudwatch:PutMetricData`** — not the instance role. Strong prior that it does, since `apps/backend`'s `MutationClientError` uses the identical pattern under the identical env file; check that metric is actually landing in prod as the cheapest confirmation. If it isn't, `AUTH_RATE_LIMIT_METRICS_DISABLED` is the safe landing state and the metric ships in a follow-up.
- **Extraction touches a package both containers ship.** Adding the emitter to `@wxyc/observability` changes a build artifact copied into `Dockerfile.auth` _and_ the backend image. The extraction is additive (no existing export changes), but the built `dist` is shared — see the org memory on stale worktree `dist`s producing phantom CI red.
- **Storage stays process-local.** Both limiters use in-memory `Map`s with no `secondaryStorage`. Today auth is one container on one host, so the effective ceiling equals the configured one. If auth is ever scaled horizontally, both ceilings multiply by N silently. Documented, not solved — there is no Redis in this stack.
- **`CF-Connecting-IP` remains unverified.** nginx logs the default `combined` format and does not record it. Adding `$http_cf_connecting_ip` to `log_format` would settle it in one deploy. Worth doing for diagnostics, but **do not gate this fix on it**: it could only ever help the ~3–4% proxied-browser arm, and per the dj-site architecture that arm is a Cloudflare-layer proxy too, so it may carry no client IP either.
- **`better-auth` upgrades.** Two behaviors this PR depends on live in a minified upstream build: `customRules === false` short-circuiting, and the `/get-session` path key after basePath stripping. Test 8 is the tripwire.
