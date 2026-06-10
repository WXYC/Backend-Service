/**
 * OIDC `trustedClients` configuration for the Better Auth `oidcProvider`.
 *
 * Lives in its own file (rather than inline in `auth.definition.ts`) so the
 * helper is testable without instantiating `betterAuth({...})` and pulling in
 * the database adapter, plugin chain, and Sentry init. Re-exported through
 * `auth.definition.ts` for consumers that already import from there.
 *
 * Add a new entry by:
 *   1. Reading the client's env vars off the `env` parameter (never
 *      `process.env` directly — it breaks unit-test injection).
 *   2. Gating the push on the full required-env-var set. A partially
 *      configured client silently produces a malformed redirect URL or a
 *      non-functional code-exchange; we'd rather omit the entry and surface
 *      "trustedClient absent" the first time someone tries to log in.
 */

export type TrustedClient = {
  clientId: string;
  clientSecret: string;
  redirectUrls: string[];
  name: string;
  type: 'web';
  disabled: boolean;
  icon: undefined;
  metadata: null;
  skipConsent: boolean;
};

export function buildTrustedClients(env: NodeJS.ProcessEnv = process.env): TrustedClient[] {
  const clients: TrustedClient[] = [];

  if (env.WIKIJS_OIDC_CLIENT_ID && env.WIKIJS_OIDC_CLIENT_SECRET && env.WIKIJS_URL) {
    clients.push({
      clientId: env.WIKIJS_OIDC_CLIENT_ID,
      clientSecret: env.WIKIJS_OIDC_CLIENT_SECRET,
      redirectUrls: [`${env.WIKIJS_URL}/login/oidc/callback`],
      name: 'Wiki.js',
      type: 'web',
      disabled: false,
      icon: undefined,
      metadata: null,
      skipConsent: true,
    });
  }

  if (env.FLOWSHEET_OIDC_CLIENT_ID && env.FLOWSHEET_OIDC_CLIENT_SECRET) {
    clients.push({
      clientId: env.FLOWSHEET_OIDC_CLIENT_ID,
      clientSecret: env.FLOWSHEET_OIDC_CLIENT_SECRET,
      redirectUrls: (env.FLOWSHEET_OIDC_REDIRECT_URLS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      name: 'Flowsheet Verifier',
      type: 'web',
      disabled: false,
      icon: undefined,
      metadata: null,
      skipConsent: true,
    });
  }

  return clients;
}
