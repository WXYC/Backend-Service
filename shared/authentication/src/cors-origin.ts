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
 *   - No usable value returns `false`, which disables the `cors` middleware —
 *     no `Access-Control-*` headers are ever emitted, so browsers refuse
 *     cross-origin reads while same-origin and non-browser clients (iOS app,
 *     supertest, curl) are unaffected. An error-level log makes the
 *     misconfigured deploy diagnosable; unlike `buildLoginPage` this does not
 *     throw, because taking the whole API down would also break the
 *     non-browser clients that never needed CORS.
 */

export type ResolvedCorsOrigin = string | string[] | false;

export function resolveCorsOrigin(
  env: NodeJS.ProcessEnv,
  envVarNames: string[] = ['FRONTEND_SOURCE']
): ResolvedCorsOrigin {
  for (const name of envVarNames) {
    const entries = (env[name] ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
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
