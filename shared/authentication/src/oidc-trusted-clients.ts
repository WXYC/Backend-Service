/**
 * OIDC `trustedClients` configuration for the Better Auth `oidcProvider`.
 *
 * Lives in its own file (rather than inline in `auth.definition.ts`) so the
 * helper is testable without instantiating `betterAuth({...})` and pulling in
 * the database adapter, plugin chain, and Sentry init.
 *
 * Add a new entry by:
 *   1. Reading the client's env vars off the `env` parameter (never
 *      `process.env` directly — it breaks unit-test injection). The single
 *      production call site in `auth.definition.ts` passes `process.env`
 *      explicitly.
 *   2. Gating the push on the full required-env-var set, INCLUDING a
 *      non-empty parsed `redirectUrls` array. A partially configured client
 *      silently produces a malformed redirect URL or a non-functional
 *      code-exchange (better-auth's authorize endpoint rejects every login
 *      with "invalid redirect URI"); we'd rather omit the entry and surface
 *      "trustedClient absent" the first time someone tries to log in.
 *
 * Trust posture (`skipConsent: true`): every client registered here is a
 * first-party WXYC tool the station already operates, so the OAuth consent
 * screen is a UX papercut, not a trust boundary. When adding a third-party
 * or less-trusted app, set `skipConsent: false` so the user sees the
 * standard consent screen.
 */

import type { Client } from 'better-auth/plugins';

export function buildTrustedClients(env: NodeJS.ProcessEnv): Client[] {
  const clients: Client[] = [];

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
    const redirectUrls = (env.FLOWSHEET_OIDC_REDIRECT_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (redirectUrls.length > 0) {
      clients.push({
        clientId: env.FLOWSHEET_OIDC_CLIENT_ID,
        clientSecret: env.FLOWSHEET_OIDC_CLIENT_SECRET,
        redirectUrls,
        name: 'Flowsheet Verifier',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
    }
  }

  return clients;
}
