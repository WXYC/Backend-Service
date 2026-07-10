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

  // wxyc-canary — the synthetic-DJ probe that runs every 5 min and walks the
  // full OIDC code + PKCE dance to catch the regression class that produced
  // #1571 (`oauthConsent` schema drift → login 500). Deliberately a PUBLIC
  // client: no `client_secret` in the canary env, and the probe stops at the
  // /authorize 302 without exchanging the code — so `type: 'public'` gates the
  // token endpoint's `client_secret` check (better-auth's
  // `node_modules/.../oidc-provider/index.mjs:541`) to require `code_verifier`
  // instead. The redirect URL is a placeholder; the canary reads the 302
  // `Location` with `redirect: 'manual'` and inspects it in-process — no
  // listener stands up at `canary.wxyc.org/authorize-echo`. See wxyc-canary#60.
  if (env.WXYC_CANARY_OIDC_CLIENT_ID) {
    clients.push({
      clientId: env.WXYC_CANARY_OIDC_CLIENT_ID,
      clientSecret: undefined,
      redirectUrls: ['https://canary.wxyc.org/authorize-echo'],
      name: 'WXYC Canary',
      type: 'public',
      disabled: false,
      icon: undefined,
      metadata: null,
      skipConsent: true,
    });
  }

  return clients;
}
