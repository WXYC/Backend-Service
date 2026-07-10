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
 *   2. Trimming each env value once at read time via `readEnv` before the
 *      truthy check and assignment. GH-secret-to-EC2 workflows can pick up
 *      a trailing newline or leading space from a paste error in a password
 *      manager; without a trim, the truthy check passes, the clientId is
 *      registered with the padding, and better-auth's strict `===` client
 *      lookup returns invalid_client on the next login (silent failure).
 *      See #1586 for the failure mode.
 *   3. Gating the push on the full required-env-var set, INCLUDING a
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
 *
 * Duplicate-clientId guard: at the end of the build, every registered
 * clientId must be unique. If an operator accidentally sets two env vars
 * to the same clientId, the sequential upsert loop in
 * `bootstrap-trusted-clients.ts` would clobber one row with the other's
 * shape (e.g. a wiki.js `type: 'web'` row flips to `type: 'public'` with a
 * null clientSecret), breaking that login flow silently. Throwing at boot
 * turns a would-be silent login regression into a loud, fixable startup
 * failure. See #1579.
 */

import type { Client } from 'better-auth/plugins';

// Extract clientId once per client so both the dedup error message and the
// `Client` object see the same trimmed value. Also names each source group
// so the dedup error can point at the two colliding env-var blocks.
interface Registration {
  source: string;
  client: Client;
}

// Trim once, at read time. Returns undefined for missing OR whitespace-only
// values so the caller can gate on truthiness against a canonical value.
const readEnv = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export function buildTrustedClients(env: NodeJS.ProcessEnv): Client[] {
  const registrations: Registration[] = [];

  const wikiClientId = readEnv(env.WIKIJS_OIDC_CLIENT_ID);
  const wikiClientSecret = readEnv(env.WIKIJS_OIDC_CLIENT_SECRET);
  const wikiUrl = readEnv(env.WIKIJS_URL);
  if (wikiClientId && wikiClientSecret && wikiUrl) {
    registrations.push({
      source: 'Wiki.js',
      client: {
        clientId: wikiClientId,
        clientSecret: wikiClientSecret,
        redirectUrls: [`${wikiUrl}/login/oidc/callback`],
        name: 'Wiki.js',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      },
    });
  }

  const flowsheetClientId = readEnv(env.FLOWSHEET_OIDC_CLIENT_ID);
  const flowsheetClientSecret = readEnv(env.FLOWSHEET_OIDC_CLIENT_SECRET);
  if (flowsheetClientId && flowsheetClientSecret) {
    const redirectUrls = (env.FLOWSHEET_OIDC_REDIRECT_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (redirectUrls.length > 0) {
      registrations.push({
        source: 'Flowsheet Verifier',
        client: {
          clientId: flowsheetClientId,
          clientSecret: flowsheetClientSecret,
          redirectUrls,
          name: 'Flowsheet Verifier',
          type: 'web',
          disabled: false,
          icon: undefined,
          metadata: null,
          skipConsent: true,
        },
      });
    }
  }

  // wxyc-canary — the synthetic-DJ probe that runs every 5 min and walks the
  // full OIDC code + PKCE dance to catch the regression class that produced
  // #1571 (`oauthConsent` schema drift → login 500). Deliberately a PUBLIC
  // client: no `client_secret` in the canary env, and the probe stops at the
  // /authorize 302 without exchanging the code — so `type: 'public'` gates the
  // token endpoint's `client_secret` check (better-auth's
  // `node_modules/.../oidc-provider/index.mjs:547`) to require `code_verifier`
  // instead.
  //
  // Redirect URL uses the `.invalid` TLD (RFC 2606 §2, reserved for guaranteed
  // non-resolution) rather than a WXYC-controlled hostname. The canary reads
  // the 302 `Location` with `redirect: 'manual'` and inspects it in-process,
  // so the host never has to resolve. Pinning to `.invalid` closes the #1584
  // exploit surface where a future S3/CDN listener on `canary.wxyc.org` would
  // become a silent redirect target under `skipConsent: true`. See
  // wxyc-canary#60 (probe) and wxyc-canary#61 (redirect-URI parameter).
  const canaryClientId = readEnv(env.WXYC_CANARY_OIDC_CLIENT_ID);
  if (canaryClientId) {
    registrations.push({
      source: 'WXYC Canary',
      client: {
        clientId: canaryClientId,
        clientSecret: undefined,
        redirectUrls: ['https://canary.wxyc.invalid/authorize-echo'],
        name: 'WXYC Canary',
        type: 'public',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      },
    });
  }

  assertUniqueClientIds(registrations);
  return registrations.map((r) => r.client);
}

// Fails loudly at boot when two configured clients share a clientId. The
// error names the offending clientId and both source groups so the operator
// can jump straight to the colliding env vars — without the names, a bare
// "duplicate clientId" message forces a grep across every WXYC_*_OIDC_CLIENT_ID
// env var to find the collision.
function assertUniqueClientIds(registrations: readonly Registration[]): void {
  const bySeenId = new Map<string, string>();
  for (const { source, client } of registrations) {
    const existingSource = bySeenId.get(client.clientId);
    if (existingSource !== undefined) {
      throw new Error(
        `OIDC trustedClients: duplicate clientId "${client.clientId}" registered by both ${existingSource} and ${source}. ` +
          `Check that WIKIJS_OIDC_CLIENT_ID, FLOWSHEET_OIDC_CLIENT_ID, and WXYC_CANARY_OIDC_CLIENT_ID are all set to distinct values.`
      );
    }
    bySeenId.set(client.clientId, source);
  }
}
