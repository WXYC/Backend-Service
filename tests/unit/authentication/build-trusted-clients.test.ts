import { buildTrustedClients } from '../../../shared/authentication/src/oidc-trusted-clients';

describe('buildTrustedClients', () => {
  describe('flowsheet client', () => {
    it('produces a flowsheet entry with parsed comma-separated redirect URLs', () => {
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://a/cb,https://b/cb',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0]).toEqual({
        clientId: 'flowsheet',
        clientSecret: 'shh',
        redirectUrls: ['https://a/cb', 'https://b/cb'],
        name: 'Flowsheet Verifier',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
    });

    it('trims surrounding whitespace around comma-separated redirect URLs', () => {
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: ' https://a/cb , https://b/cb ',
      });

      expect(clients[0].redirectUrls).toEqual(['https://a/cb', 'https://b/cb']);
    });

    it('omits the flowsheet entry when FLOWSHEET_OIDC_REDIRECT_URLS is unset', () => {
      // Match the file-level docstring contract: a partially configured
      // client is omitted, not silently pushed with a broken redirect-URL
      // allowlist. Without this gate, better-auth's authorize endpoint would
      // reject every login with "invalid redirect URI".
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
      });

      expect(clients).toEqual([]);
    });

    it('omits the flowsheet entry when FLOWSHEET_OIDC_REDIRECT_URLS has only blank entries', () => {
      // ' , , ,' → ['', '', '', ''] after trim+filter Boolean → [].
      // Same omission as the unset case for the same reason.
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: ' , , ,',
      });

      expect(clients).toEqual([]);
    });

    it('keeps the valid URLs and drops the blank entries when both are mixed', () => {
      // Pins the .filter(Boolean) semantics: an operator with a typo'd
      // trailing comma or an accidental blank slot in the middle still gets
      // the entry registered for the URLs that parse — we don't reject the
      // whole list because one entry was blank.
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://a/cb, , https://b/cb',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].redirectUrls).toEqual(['https://a/cb', 'https://b/cb']);
    });

    it('omits the flowsheet entry when FLOWSHEET_OIDC_CLIENT_ID is unset', () => {
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://a/cb',
      });

      expect(clients).toEqual([]);
    });

    it('omits the flowsheet entry when FLOWSHEET_OIDC_CLIENT_SECRET is unset', () => {
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://a/cb',
      });

      expect(clients).toEqual([]);
    });
  });

  describe('wiki.js client', () => {
    it('preserves the existing inline-literal shape field-for-field', () => {
      // Behavior-preserving refactor: a Wiki.js entry built from the same env
      // vars the current inline literal reads must equal that literal exactly.
      // Reviewers should diff this expectation against the inline literal's
      // object contents on `main` (pre-extraction, lines 180-190 of
      // `shared/authentication/src/auth.definition.ts`).
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
        WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
        WIKIJS_URL: 'https://wiki.wxyc.org',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0]).toEqual({
        clientId: 'wiki-id',
        clientSecret: 'wiki-secret',
        redirectUrls: ['https://wiki.wxyc.org/login/oidc/callback'],
        name: 'Wiki.js',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
    });

    it('omits the wiki.js entry when WIKIJS_URL is missing', () => {
      // Defensive gate that turns the current silent `undefined/login/oidc/callback`
      // misconfiguration into a visible "no Wiki.js trustedClient" failure mode.
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
        WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].name).toBe('Flowsheet Verifier');
    });
  });

  describe('wxyc-canary client', () => {
    it('produces a public-client entry when WXYC_CANARY_OIDC_CLIENT_ID is set', () => {
      // The canary is a public client (PKCE-only): no client_secret in its env,
      // and its 5-min probe stops at the /authorize 302 without exchanging
      // the code — so `type: 'public'` gates the code-exchange path (better-
      // auth's `node_modules/.../oidc-provider/index.mjs:541`) to require
      // `code_verifier` instead of `client_secret`. The redirect URL is a
      // placeholder — canary.wxyc.org/authorize-echo doesn't have to resolve
      // because the canary reads the 302 `Location` with `redirect: 'manual'`
      // and inspects it in-process. Contract pinned by wxyc-canary#60 (the
      // blocked-by ticket that consumes this trustedClient).
      const clients = buildTrustedClients({
        WXYC_CANARY_OIDC_CLIENT_ID: 'wxyc-canary',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0]).toEqual({
        clientId: 'wxyc-canary',
        clientSecret: undefined,
        redirectUrls: ['https://canary.wxyc.org/authorize-echo'],
        name: 'WXYC Canary',
        type: 'public',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
    });

    it('omits the wxyc-canary entry when WXYC_CANARY_OIDC_CLIENT_ID is unset', () => {
      // Matches the file-level docstring: a partially configured client
      // (here: absent id) is omitted rather than silently pushed. Local dev
      // .env-less boots won't assert a canary client that isn't wired
      // upstream on prod. Symmetric with the wiki.js / flowsheet unset gates.
      expect(buildTrustedClients({})).toEqual([]);
    });

    it('omits the wxyc-canary entry when WXYC_CANARY_OIDC_CLIENT_ID is empty string', () => {
      // Defense-in-depth: an operator who accidentally sets the var to ''
      // in the EC2 `.env` shouldn't produce a client with clientId ''. The
      // truthy check on the env var covers this.
      expect(buildTrustedClients({ WXYC_CANARY_OIDC_CLIENT_ID: '' })).toEqual([]);
    });

    it('does not require or read WXYC_CANARY_OIDC_CLIENT_SECRET (public client)', () => {
      // The canary env deliberately carries NO secret — its whole scope-of-
      // damage argument is "a leaked canary env carries no OIDC secret." A
      // future refactor that quietly starts gating on a *_SECRET env var
      // would rebuild the exact exposure the ticket exists to avoid. Pin the
      // absence explicitly by asserting the client is still produced when
      // only the id is present, and clientSecret comes back undefined.
      const clients = buildTrustedClients({
        WXYC_CANARY_OIDC_CLIENT_ID: 'wxyc-canary',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].clientSecret).toBeUndefined();
      expect(clients[0].type).toBe('public');
    });
  });

  describe('all clients together', () => {
    it('returns Wiki.js first, Flowsheet second, WXYC Canary third, when all are fully configured', () => {
      // Full-shape assertion (not just `.name`): a refactor that silently
      // flips wiki.js's `type: 'web' → 'public'` or drops `skipConsent` from
      // flowsheet would sail past a name-only check. The individual describe
      // blocks pin the shape when each client is configured in isolation;
      // pin it again in the "all three together" configuration so an
      // ordering-dependent bug (e.g. mutation of a shared literal) can't
      // hide either.
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
        WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
        WIKIJS_URL: 'https://wiki.wxyc.org',
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
        WXYC_CANARY_OIDC_CLIENT_ID: 'wxyc-canary',
      });

      expect(clients).toHaveLength(3);
      expect(clients[0]).toEqual({
        clientId: 'wiki-id',
        clientSecret: 'wiki-secret',
        redirectUrls: ['https://wiki.wxyc.org/login/oidc/callback'],
        name: 'Wiki.js',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
      expect(clients[1]).toEqual({
        clientId: 'flowsheet',
        clientSecret: 'shh',
        redirectUrls: ['https://flowsheet.wxyc.org/auth/callback'],
        name: 'Flowsheet Verifier',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
      expect(clients[2]).toEqual({
        clientId: 'wxyc-canary',
        clientSecret: undefined,
        redirectUrls: ['https://canary.wxyc.org/authorize-echo'],
        name: 'WXYC Canary',
        type: 'public',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
    });

    it('still returns Wiki.js first, Flowsheet second when only those two are configured', () => {
      // Pins the pre-canary ordering — a refactor that appends the canary
      // block in the wrong place (before wiki.js / flowsheet) shouldn't
      // silently perturb the existing two-client order the previous test
      // used to lock in on its own. Full-shape here too so a partial-config
      // refactor can't drop `skipConsent` or flip `type` unnoticed.
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
        WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
        WIKIJS_URL: 'https://wiki.wxyc.org',
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
      });

      expect(clients).toHaveLength(2);
      expect(clients[0]).toEqual({
        clientId: 'wiki-id',
        clientSecret: 'wiki-secret',
        redirectUrls: ['https://wiki.wxyc.org/login/oidc/callback'],
        name: 'Wiki.js',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
      expect(clients[1]).toEqual({
        clientId: 'flowsheet',
        clientSecret: 'shh',
        redirectUrls: ['https://flowsheet.wxyc.org/auth/callback'],
        name: 'Flowsheet Verifier',
        type: 'web',
        disabled: false,
        icon: undefined,
        metadata: null,
        skipConsent: true,
      });
    });
  });

  describe('neither client', () => {
    it('returns an empty array when no client env vars are set', () => {
      expect(buildTrustedClients({})).toEqual([]);
    });
  });
});
