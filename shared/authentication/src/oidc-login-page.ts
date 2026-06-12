/**
 * `loginPage` URL for the Better Auth `oidcProvider`.
 *
 * Better Auth's authorize endpoint redirects an unauthenticated user to
 * `${loginPage}?${original-query-string}` and sets a signed `oidc_login_prompt`
 * cookie. The dj-site Next.js app (the canonical WXYC login UI) hosts that
 * page at `/login` and, on successful sign-in, redirects back to
 * `${api}/auth/oauth2/authorize?<original-query>` to resume the OIDC flow.
 *
 * Lives in its own file so the helper is testable without instantiating
 * `betterAuth({...})` and pulling in the database adapter, plugin chain, and
 * Sentry init — same rationale as `oidc-trusted-clients.ts`.
 *
 * Env contract:
 *   - `FRONTEND_SOURCE` (required outside test/dev) — the dj-site origin.
 *     Parsed with `new URL()`; only `http:`/`https:` are accepted; only the
 *     origin is used (path / query / fragment on the env value are discarded,
 *     so paste-from-browser-URL accidents don't poison the OIDC redirect
 *     target).
 *   - When `NODE_ENV` is `development` or `test` (the only two values that
 *     opt-in to the localhost fallback), missing/empty/whitespace values fall
 *     back to `http://localhost:3000`. Every other `NODE_ENV` — including
 *     unset, `production`, `staging`, etc. — is treated as production-shaped
 *     and throws at module load when `FRONTEND_SOURCE` is missing. Inverting
 *     the polarity this way matches the defense-in-depth posture documented
 *     in `auth.middleware.ts` for BS#1097 (NODE_ENV unset on EC2 silently
 *     enabled an AUTH_BYPASS dev hatch in prod).
 *   - Silent localhost fallback in prod would 302 every unauthenticated OIDC
 *     user to a host their browser cannot reach with no auth-service error,
 *     so the throw is the only acceptable failure mode.
 *
 * `FRONTEND_SOURCE` is also consumed by `trustedOrigins` and
 * `rewriteUrlForFrontend`; each applies its own normalization today.
 */

const DEV_FALLBACK = 'http://localhost:3000';
const DEV_LIKE_NODE_ENVS = new Set(['development', 'test']);
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export function buildLoginPage(env: NodeJS.ProcessEnv): string {
  const isDevLike = DEV_LIKE_NODE_ENVS.has(env.NODE_ENV ?? '');
  const raw = env.FRONTEND_SOURCE?.trim();
  if (!raw) {
    if (!isDevLike) {
      throw new Error(
        '[oidc-login-page] FRONTEND_SOURCE must be set when NODE_ENV is not development or test — it determines the OIDC loginPage redirect target. Refusing to fall back to http://localhost:3000.'
      );
    }
    return `${DEV_FALLBACK}/login`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Don't echo the env value into the error message: operators sometimes
    // paste URLs that embed session tokens or other query secrets while
    // debugging OAuth flows, and Sentry / CloudWatch would keep the leaked
    // value indefinitely. The operator can re-check their own config.
    throw new Error(
      '[oidc-login-page] FRONTEND_SOURCE is not a valid URL. Expected an absolute URL such as https://dj.wxyc.org.'
    );
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    // `new URL('mailto:...')` and other non-special-scheme inputs parse
    // successfully but `parsed.origin` returns the literal string 'null',
    // producing a useless 'null/login' redirect target. Reject explicitly.
    throw new Error(`[oidc-login-page] FRONTEND_SOURCE must use http: or https:; got ${parsed.protocol}`);
  }
  return `${parsed.origin}/login`;
}
