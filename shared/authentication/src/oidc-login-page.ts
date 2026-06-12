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
 *   - `FRONTEND_SOURCE` (required in production) — the dj-site origin. Parsed
 *     with `new URL()`; only the origin is used (any path / query / fragment
 *     on the env value is discarded, so paste-from-browser-URL accidents
 *     don't poison the OIDC redirect target).
 *   - In dev (`NODE_ENV !== 'production'`), missing/empty/whitespace
 *     `FRONTEND_SOURCE` falls back to `http://localhost:3000`.
 *   - In production, missing `FRONTEND_SOURCE` throws at module load. Silent
 *     localhost fallback in prod would 302 every unauthenticated OIDC user to
 *     a host their browser can't reach, with no auth-service error.
 *
 * `FRONTEND_SOURCE` is also consumed by `trustedOrigins` and
 * `rewriteUrlForFrontend`. Each applies its own normalization today; future
 * cleanup could collapse them behind a shared `getFrontendBaseUrl(env)`.
 */

const DEV_FALLBACK = 'http://localhost:3000';

export function buildLoginPage(env: NodeJS.ProcessEnv): string {
  const raw = env.FRONTEND_SOURCE?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[oidc-login-page] FRONTEND_SOURCE must be set in production — it determines the OIDC loginPage redirect target. Refusing to fall back to http://localhost:3000.'
      );
    }
    return `${DEV_FALLBACK}/login`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `[oidc-login-page] FRONTEND_SOURCE is not a valid URL: ${JSON.stringify(raw)}. Expected an absolute URL such as https://dj.wxyc.org.`
    );
  }
  return `${parsed.origin}/login`;
}
