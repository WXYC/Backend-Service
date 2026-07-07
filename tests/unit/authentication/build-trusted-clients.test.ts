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

  describe('both clients', () => {
    it('returns Wiki.js first, Flowsheet second, when both are fully configured', () => {
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
        WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
        WIKIJS_URL: 'https://wiki.wxyc.org',
        FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
        FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
      });

      expect(clients).toHaveLength(2);
      expect(clients[0].name).toBe('Wiki.js');
      expect(clients[1].name).toBe('Flowsheet Verifier');
    });
  });

  describe('neither client', () => {
    it('returns an empty array when no client env vars are set', () => {
      expect(buildTrustedClients({})).toEqual([]);
    });
  });
});
