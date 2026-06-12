/**
 * `loginPage` URL for the Better Auth `oidcProvider`.
 *
 * Better Auth's authorize endpoint redirects an unauthenticated user to
 * `${loginPage}?${original-query-string}` and sets a signed `oidc_login_prompt`
 * cookie. The dj-site Next.js app (the canonical WXYC login UI) hosts that
 * page at `/login` and, on successful sign-in, redirects back to
 * `${api}/auth/oauth2/authorize?<original-query>` to resume the OIDC flow.
 *
 * Lives in its own file (rather than inline in `auth.definition.ts`) so the
 * helper is testable without instantiating `betterAuth({...})` and pulling in
 * the database adapter, plugin chain, and Sentry init — same rationale as
 * `oidc-trusted-clients.ts`.
 *
 * Env var reuse: `FRONTEND_SOURCE` is already the dj-site base URL across the
 * auth surface (`trustedOrigins`, email-link rewriting via
 * `rewriteUrlForFrontend`). Reusing it here means one env var defines the
 * canonical frontend origin for every redirect target.
 */

export function buildLoginPage(env: NodeJS.ProcessEnv): string {
  const base = (env.FRONTEND_SOURCE || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/login`;
}
