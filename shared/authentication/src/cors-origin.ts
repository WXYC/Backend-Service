/**
 * Resolve the Express-level `cors` middleware `origin` option from env
 * configuration — fail closed instead of open (BS#1107).
 *
 * Both apps used to configure `origin: process.env.FRONTEND_SOURCE || '*'`
 * next to `credentials: true`. With the `cors` package, `'*'` + credentials
 * reflects the request's `Origin` header back as
 * `Access-Control-Allow-Origin` and emits
 * `Access-Control-Allow-Credentials: true`, so any web origin could make
 * credentialed (cookie-bearing) requests whenever `FRONTEND_SOURCE` was
 * forgotten in a deploy. This helper removes the wildcard fallback entirely.
 *
 * Lives in its own file so the helper is testable without instantiating
 * `betterAuth({...})` — same rationale as `oidc-login-page.ts` and
 * `oidc-trusted-clients.ts`.
 *
 * Env contract:
 *   - `envVarNames` are consulted in order; the first var with a non-empty
 *     value wins. The backend passes the default (`FRONTEND_SOURCE` only);
 *     the auth service additionally falls back to
 *     `BETTER_AUTH_TRUSTED_ORIGINS` so a deploy that configures better-auth's
 *     trusted origins but not `FRONTEND_SOURCE` keeps serving its login flow
 *     instead of failing closed.
 *   - Values are comma-separated origin lists, matching the
 *     `BETTER_AUTH_TRUSTED_ORIGINS` parse in `auth.definition.ts`
 *     (`trustedOrigins`): entries are trimmed and empty segments dropped.
 *   - Exactly one entry returns the bare string, preserving the pre-BS#1107
 *     header emission for single-origin deploys (the `cors` package sends the
 *     configured literal as ACAO on every response). Multiple entries return
 *     an array, which the `cors` package treats as a whitelist (ACAO is only
 *     emitted when the request's Origin matches an entry).
 *   - `previewVarName` (`CORS_PREVIEW_ORIGINS`) is a SEPARATE, comma-separated
 *     list that is UNIONED onto whatever the primary list resolved to, rather
 *     than being consulted first-wins like the names above. It exists because
 *     the wildcard preview origins and the primary origin cannot share a
 *     variable: `FRONTEND_SOURCE` is read as a SINGLE origin by
 *     `oidc-login-page.ts`, `url-rewrite.ts`, and `provision-user.ts`, and
 *     `new URL('https://dj.wxyc.org,https://*.wxyc-dj.pages.dev')` does not
 *     throw — it parses, yielding host `dj.wxyc.org,https`. A comma-joined
 *     value therefore sails through every guard on those paths and silently
 *     points the OIDC login page, every password-reset email, and every DJ
 *     invite at a host that does not exist. Keeping the previews in their own
 *     variable makes that unrepresentable rather than merely discouraged.
 *   - No usable value in the primary list returns `false`, which disables the
 *     `cors` middleware —
 *     no `Access-Control-*` headers are ever emitted, so browsers refuse
 *     cross-origin reads while same-origin and non-browser clients (iOS app,
 *     supertest, curl) are unaffected. An error-level log makes the
 *     misconfigured deploy diagnosable; unlike `buildLoginPage` this does not
 *     throw, because taking the whole API down would also break the
 *     non-browser clients that never needed CORS.
 */

export type CorsOriginPattern = string | RegExp;
export type ResolvedCorsOrigin = CorsOriginPattern | CorsOriginPattern[] | false;

/** Split a comma-separated origin list into trimmed, non-empty entries. */
const splitOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

/**
 * Compile a single trimmed origin entry into the pattern the `cors` package
 * consumes. Literal origins pass through as strings (exact match). Wildcard
 * origins (containing `*` or `?`) become an anchored RegExp: `*` matches any
 * run of non-separator characters and `?` matches exactly one, so
 * `https://*.wxyc-dj.pages.dev` matches `https://abc123.wxyc-dj.pages.dev` but
 * not `https://evil.com` or a suffix like `…pages.dev.evil.com` (the `$`
 * anchor). `[^/\\]` as the wildcard class mirrors better-auth's
 * `wildcardMatch` default separator so both trust layers agree.
 *
 * Breadth caveat — `/` and `\` are the ONLY separators, so `*` DOES cross
 * dots: `https://*.wxyc-dj.pages.dev` also trusts arbitrarily-deep subdomains
 * (`https://a.b.wxyc-dj.pages.dev`). That is safe here only because WXYC owns
 * the entire `wxyc-dj.pages.dev` zone — every host under it is a WXYC Pages
 * deployment, so a wildcard can only widen the subdomains WXYC controls.
 * Do NOT configure a wildcard over a multi-tenant apex (e.g.
 * `https://*.pages.dev`): that would trust every Cloudflare Pages project,
 * including attacker-controlled ones, for credentialed requests. The wildcard
 * segment must always be pinned to a zone WXYC owns end-to-end.
 */
export function toCorsPattern(entry: string): CorsOriginPattern {
  if (!/[*?]/.test(entry)) return entry;
  const source = Array.from(entry)
    .map((ch) => {
      if (ch === '*') return '[^/\\\\]*';
      if (ch === '?') return '[^/\\\\]';
      // Escape every regex metacharacter in the literal portions.
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  // `source` is built from a deploy-controlled env var with every regex
  // metacharacter in the literal portions escaped above and only `*`/`?`
  // expanded to bounded, non-backtracking classes — not attacker input.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${source}$`);
}

export function resolveCorsOrigin(
  env: NodeJS.ProcessEnv,
  envVarNames: string[] = ['FRONTEND_SOURCE'],
  previewVarName = 'CORS_PREVIEW_ORIGINS'
): ResolvedCorsOrigin {
  const previews = splitOrigins(env[previewVarName]).map(toCorsPattern);

  for (const name of envVarNames) {
    const entries = splitOrigins(env[name]).map(toCorsPattern);
    if (entries.length === 0) continue;
    // No previews configured: return exactly what this function always
    // returned, including the bare-pattern form for a single entry, so an
    // unset CORS_PREVIEW_ORIGINS is byte-for-byte the pre-existing behavior.
    if (previews.length === 0) return entries.length === 1 ? entries[0] : entries;
    // With previews the result is always an array, which the `cors` package
    // treats as a whitelist: ACAO is emitted only when the request Origin
    // matches an entry, rather than the configured literal being sent
    // unconditionally. The primary origin still matches, so it is unaffected;
    // origins that match nothing now get no ACAO instead of a header they
    // could never use. That is the safer direction, and it happens only when
    // previews are explicitly configured.
    return [...entries, ...previews];
  }

  // Previews alone do not open the door. FRONTEND_SOURCE is required by the
  // login page, the reset/verification emails, and invite links regardless of
  // CORS, so a deploy that sets only the preview list is misconfigured — and
  // BS#1107's fail-closed contract is the whole point of this function.
  if (previews.length > 0) {
    console.error(
      `[cors] ${previewVarName} is set but none of ${envVarNames.join(', ')} is — ignoring the preview origins and ` +
        'serving no CORS headers. Preview origins widen the primary allow-list; they do not replace it.'
    );
  }

  console.error(
    `[cors] None of ${envVarNames.join(', ')} is set — cross-origin requests are disabled (no CORS headers will be served). ` +
      `Set ${envVarNames[0]} to the frontend origin (comma-separated for multiple origins). ` +
      'Refusing to fall back to the credentialed wildcard (BS#1107).'
  );
  return false;
}

/**
 * The anonymous read routes the public `wxyc.org` pages call (BS#2061).
 *
 * `website` is a static export, so the three Phase 4 listener pages
 * (WXYC/wiki#91 — live playlist, airplay search, historical archive) fetch
 * `api.wxyc.org` from the browser and need `Access-Control-Allow-Origin`. They
 * must NOT get it by being appended to `FRONTEND_SOURCE`: `credentials: true`
 * sits beside `origin` on the single `cors()` mount, so that would hand the
 * public web credentialed access to the entire API — the BS#1107 hazard, minus
 * the wildcard.
 *
 * Exact matches only. A prefix match would leak the grant to every route under
 * `/flowsheet/`, including the authenticated mutations.
 */
export const PUBLIC_READ_CORS_ROUTES: readonly string[] = ['/flowsheet', '/flowsheet/range', '/flowsheet/search'];

/**
 * Origins allowed to read {@link PUBLIC_READ_CORS_ROUTES} cross-origin without
 * credentials, from `PUBLIC_READ_ORIGINS` (comma-separated).
 *
 * Values are normalized to a bare origin via `URL`, matching what a browser
 * actually puts in the `Origin` header. Without that, the natural
 * paste-from-browser forms — a trailing slash, a path, mixed case in the host —
 * would survive as entries that can never equal any real `Origin`, and the
 * failure would be invisible: the startup log would happily list the typo, and
 * every page load would silently fall through to the credentialed branch and be
 * blocked by the browser. Since setting this variable is a manual deploy step,
 * a value that *looks* configured but matches nothing is the likeliest way this
 * feature breaks. Anything unparseable is dropped with a warning naming it.
 *
 * Unset returns `[]` and logs nothing — unlike `FRONTEND_SOURCE`, an absent
 * value here is a legitimate steady state (local dev, and production until the
 * D3 pages ship), so it must not emit a misconfiguration error. `[]` means no
 * origin gets the public grant, which is the fail-closed direction.
 *
 * A `*` entry is dropped rather than honored. It could never match a real
 * `Origin` header anyway (comparison is exact), but dropping it keeps the
 * no-wildcard rule true by construction rather than by accident.
 */
export function resolvePublicCorsOrigins(env: NodeJS.ProcessEnv, envVarName = 'PUBLIC_READ_ORIGINS'): string[] {
  const normalized: string[] = [];
  for (const raw of (env[envVarName] ?? '').split(',')) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (entry === '*') {
      console.warn(`[cors] Ignoring '*' in ${envVarName} — the public read grant is an exact-origin allow-list.`);
      continue;
    }
    let origin: string;
    try {
      origin = new URL(entry).origin;
    } catch {
      console.warn(
        `[cors] Ignoring unparseable ${envVarName} entry "${entry}" — expected an origin like https://wxyc.org.`
      );
      continue;
    }
    // `new URL('mailto:x').origin` is the string "null"; only http(s) origins
    // can appear in a browser's Origin header for our purposes.
    if (!/^https?:\/\//.test(origin)) {
      console.warn(`[cors] Ignoring non-http(s) ${envVarName} entry "${entry}".`);
      continue;
    }
    if (origin !== entry) {
      console.warn(`[cors] Normalized ${envVarName} entry "${entry}" to "${origin}" — configure the bare origin.`);
    }
    if (!normalized.includes(origin)) normalized.push(origin);
  }
  return normalized;
}

/**
 * The subset of an Express request {@link isPublicReadGrant} reads. Headers are
 * typed as Node delivers them — an unrecognized header name is
 * `string | string[]`, so `access-control-request-method` needs narrowing.
 */
export interface CorsModeRequest {
  method: string;
  path: string;
  headers: { origin?: string; 'access-control-request-method'?: string | string[] };
}

/**
 * Whether this request gets the credential-less public-read grant rather than
 * the existing credentialed contract (BS#2061).
 *
 * One predicate consulted by one `cors()` delegate, rather than two stacked
 * `cors()` layers. In production `FRONTEND_SOURCE` holds a single origin, so
 * `resolveCorsOrigin` returns a bare string and the `cors` package emits it as
 * ACAO *unconditionally* — a second, earlier layer's `https://wxyc.org` header
 * would simply be overwritten by `https://dj.wxyc.org` on the way out. Deciding
 * once makes that impossible.
 *
 * Three conditions, each of which is the whole guard against a different
 * over-grant:
 *
 *   - **Origin is on the allow-list.** Exact match against the normalized
 *     `PUBLIC_READ_ORIGINS`; nothing is ever echoed back.
 *   - **Method is GET**, read from `Access-Control-Request-Method` on a
 *     preflight so a GET preflight is granted and a mutation preflight is not.
 *   - **Path is an exact member of {@link PUBLIC_READ_CORS_ROUTES}.** A prefix
 *     match would extend the grant to every route beneath `/flowsheet/`,
 *     including the authenticated mutations.
 *
 * Path comparison is case-insensitive because Express's router is: `case
 * sensitive routing` is off by default and the app never enables it, so
 * `/Flowsheet/Search` reaches the same handler. Matching case-sensitively here
 * would serve a 200 the browser then discards — safe, but an asymmetry between
 * the allow-list and the router that resolves the same strings.
 */
export function isPublicReadGrant(req: CorsModeRequest, publicOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || !publicOrigins.includes(origin)) return false;

  const requested = req.headers['access-control-request-method'];
  const method = req.method === 'OPTIONS' ? (Array.isArray(requested) ? requested[0] : requested) : req.method;
  if (method?.toUpperCase() !== 'GET') return false;

  // Express's req.path excludes the query string but keeps a trailing slash.
  const path = (req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path).toLowerCase();
  return PUBLIC_READ_CORS_ROUTES.includes(path);
}
