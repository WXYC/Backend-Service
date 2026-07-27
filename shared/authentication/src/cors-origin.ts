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
 *   - A wildcard entry (one containing `*` or `?`) is compiled to a RegExp so
 *     the `cors` package matches it against the request Origin the same way
 *     better-auth's `trustedOrigins` does. This is what lets us trust the
 *     dj-site Cloudflare Pages preview deployments — every branch/commit gets
 *     a fresh `https://<hash>.wxyc-dj.pages.dev` host that can't be enumerated
 *     ahead of time, so we trust the whole subdomain with
 *     `https://*.wxyc-dj.pages.dev`. Without this the Express CORS layer would
 *     reject the preview origin even though better-auth's own `trustedOrigins`
 *     (which understands wildcards natively) trusts it, so credentialed
 *     browser calls to the auth service would still fail their preflight.
 *     `*` and `?` match within a single origin segment (they don't cross `/`),
 *     mirroring better-auth's `matchesOriginPattern` semantics. Literal entries
 *     are left as plain strings so exact-origin deploys are byte-for-byte
 *     unchanged.
 *   - Exactly one entry returns the bare pattern (string or RegExp), preserving
 *     the pre-BS#1107 header emission for single-origin deploys (the `cors`
 *     package sends the configured literal as ACAO on every response, or
 *     reflects the matched Origin for a single wildcard). Multiple entries
 *     return an array, which the `cors` package treats as a whitelist (ACAO is
 *     only emitted when the request's Origin matches an entry).
 *   - No usable value returns `false`, which disables the `cors` middleware —
 *     no `Access-Control-*` headers are ever emitted, so browsers refuse
 *     cross-origin reads while same-origin and non-browser clients (iOS app,
 *     supertest, curl) are unaffected. An error-level log makes the
 *     misconfigured deploy diagnosable; unlike `buildLoginPage` this does not
 *     throw, because taking the whole API down would also break the
 *     non-browser clients that never needed CORS.
 */

export type CorsOriginPattern = string | RegExp;
export type ResolvedCorsOrigin = CorsOriginPattern | CorsOriginPattern[] | false;

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
function toCorsPattern(entry: string): CorsOriginPattern {
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
  envVarNames: string[] = ['FRONTEND_SOURCE']
): ResolvedCorsOrigin {
  for (const name of envVarNames) {
    const entries = (env[name] ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map(toCorsPattern);
    if (entries.length === 1) return entries[0];
    if (entries.length > 1) return entries;
  }
  console.error(
    `[cors] None of ${envVarNames.join(', ')} is set — cross-origin requests are disabled (no CORS headers will be served). ` +
      `Set ${envVarNames[0]} to the frontend origin (comma-separated for multiple origins). ` +
      'Refusing to fall back to the credentialed wildcard (BS#1107).'
  );
  return false;
}
