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
        redirectUrls: ['https://canary.wxyc.invalid/authorize-echo'],
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
        redirectUrls: ['https://canary.wxyc.invalid/authorize-echo'],
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

  describe('env-var whitespace trimming', () => {
    // #1586 — env vars written via GH-secret-to-EC2 workflows can pick up a
    // trailing newline or space from a paste error in a password manager. The
    // truthy check passes, the clientId is registered with the padding, and
    // better-auth's strict `===` client lookup returns invalid_client on the
    // next login. Silent failure mode — the operator sees a green workflow
    // and a broken login. Trim before the truthy check and before the
    // assignment so both the gate and the resulting row use the canonical
    // value.

    it('trims a trailing newline off WXYC_CANARY_OIDC_CLIENT_ID', () => {
      const clients = buildTrustedClients({
        WXYC_CANARY_OIDC_CLIENT_ID: 'wxyc-canary\n',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].clientId).toBe('wxyc-canary');
    });

    it('trims leading and trailing spaces off WXYC_CANARY_OIDC_CLIENT_ID', () => {
      const clients = buildTrustedClients({
        WXYC_CANARY_OIDC_CLIENT_ID: '  wxyc-canary  ',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].clientId).toBe('wxyc-canary');
    });

    it('treats whitespace-only WXYC_CANARY_OIDC_CLIENT_ID as unset', () => {
      // '   ' trims to '' — same as unset. Falsy trimmed value gates the
      // whole block off, so no client is registered.
      const clients = buildTrustedClients({
        WXYC_CANARY_OIDC_CLIENT_ID: '   ',
      });

      expect(clients).toEqual([]);
    });

    it('trims whitespace off all three wiki.js env vars', () => {
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: '  wiki-id\n',
        WIKIJS_OIDC_CLIENT_SECRET: '  wiki-secret  ',
        WIKIJS_URL: '  https://wiki.wxyc.org  ',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].clientId).toBe('wiki-id');
      expect(clients[0].clientSecret).toBe('wiki-secret');
      // Redirect URL is built from the trimmed WIKIJS_URL — no stray spaces
      // that would send the callback to a malformed origin.
      expect(clients[0].redirectUrls).toEqual(['https://wiki.wxyc.org/login/oidc/callback']);
    });

    it('treats whitespace-only WIKIJS_URL as unset (omits the wiki.js entry)', () => {
      const clients = buildTrustedClients({
        WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
        WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
        WIKIJS_URL: '   ',
      });

      expect(clients).toEqual([]);
    });

    it('trims whitespace off flowsheet env vars', () => {
      const clients = buildTrustedClients({
        FLOWSHEET_OIDC_CLIENT_ID: '  flowsheet\n',
        FLOWSHEET_OIDC_CLIENT_SECRET: '  shh  ',
        FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].clientId).toBe('flowsheet');
      expect(clients[0].clientSecret).toBe('shh');
    });
  });

  describe('canary redirect placeholder uses .invalid TLD', () => {
    // #1584 — RFC 2606 §2 reserves the `.invalid` TLD for guaranteed
    // non-resolution. The original placeholder `canary.wxyc.org` is a
    // WXYC-controlled hostname; if anyone ever stood up an S3 static page or
    // CDN listener there, the `skipConsent: true` bypass would let an
    // attacker-crafted `/oauth2/authorize` URL silently mint a code and
    // redirect it to their controlled listener. Pin the `.invalid` TLD
    // explicitly so a future refactor can't accidentally revert to a
    // resolvable hostname.
    it('registers the canary redirect URL against the .invalid TLD', () => {
      const clients = buildTrustedClients({
        WXYC_CANARY_OIDC_CLIENT_ID: 'wxyc-canary',
      });

      expect(clients).toHaveLength(1);
      expect(clients[0].redirectUrls).toEqual(['https://canary.wxyc.invalid/authorize-echo']);
    });
  });

  describe('duplicate clientId guard', () => {
    // #1579 — buildTrustedClients builds up to three entries from three
    // env-gated blocks. If two blocks emit the same clientId (operator
    // accidentally sets WXYC_CANARY_OIDC_CLIENT_ID=wiki-id, for example), the
    // sequential upsert loop in bootstrap-trusted-clients writes each entry
    // under the same DB primary key in order — so the second entry's
    // {type, clientSecret, redirectUrls} clobbers the first. In the wiki-vs-
    // canary collision case, wiki.js becomes type:'public' with a null
    // clientSecret, breaking the wiki.js login flow silently. Fail loudly at
    // boot so the operator sees the misconfiguration before login traffic hits.

    it('throws when two configured clients share a clientId', () => {
      // Same clientId reused across the canary and wiki.js env-var blocks.
      expect(() =>
        buildTrustedClients({
          WIKIJS_OIDC_CLIENT_ID: 'shared-id',
          WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
          WIKIJS_URL: 'https://wiki.wxyc.org',
          WXYC_CANARY_OIDC_CLIENT_ID: 'shared-id',
        })
      ).toThrow(/shared-id/);
    });

    it('names both offending env-var groups in the error message', () => {
      // The operator needs to know which env vars collided to fix the paste
      // error. A bare "duplicate clientId" message forces them to grep every
      // WXYC_*_OIDC_CLIENT_ID env var to find the collision.
      let thrown: unknown;
      try {
        buildTrustedClients({
          WIKIJS_OIDC_CLIENT_ID: 'shared-id',
          WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
          WIKIJS_URL: 'https://wiki.wxyc.org',
          WXYC_CANARY_OIDC_CLIENT_ID: 'shared-id',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error;
      expect(err.message).toMatch(/Wiki\.js/);
      expect(err.message).toMatch(/WXYC Canary/);
    });

    it('throws on a flowsheet/canary collision (symmetry check)', () => {
      // The guard treats every client identically, not just wiki-vs-canary.
      // A future fourth client picks up the same protection for free.
      expect(() =>
        buildTrustedClients({
          FLOWSHEET_OIDC_CLIENT_ID: 'shared-id',
          FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
          FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
          WXYC_CANARY_OIDC_CLIENT_ID: 'shared-id',
        })
      ).toThrow(/shared-id/);
    });

    it('does not throw when three distinct clientIds are configured (happy-path regression)', () => {
      // No behavior change for the correctly-configured case — this is the
      // one already exercised by "all clients together" but pinned separately
      // so a regression that always-throws on non-empty input is caught.
      expect(() =>
        buildTrustedClients({
          WIKIJS_OIDC_CLIENT_ID: 'wiki-id',
          WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
          WIKIJS_URL: 'https://wiki.wxyc.org',
          FLOWSHEET_OIDC_CLIENT_ID: 'flowsheet',
          FLOWSHEET_OIDC_CLIENT_SECRET: 'shh',
          FLOWSHEET_OIDC_REDIRECT_URLS: 'https://flowsheet.wxyc.org/auth/callback',
          WXYC_CANARY_OIDC_CLIENT_ID: 'wxyc-canary',
        })
      ).not.toThrow();
    });

    it('detects collisions only after trimming (whitespace-padded matches trim to the same value)', () => {
      // Belt-and-suspenders: the trim guard from #1586 must apply before the
      // dedup guard, so a paste-error trailing-space collision surfaces as a
      // dedup violation instead of silently registering two "distinct" ids
      // that differ only in trailing whitespace.
      expect(() =>
        buildTrustedClients({
          WIKIJS_OIDC_CLIENT_ID: 'shared-id',
          WIKIJS_OIDC_CLIENT_SECRET: 'wiki-secret',
          WIKIJS_URL: 'https://wiki.wxyc.org',
          WXYC_CANARY_OIDC_CLIENT_ID: 'shared-id\n',
        })
      ).toThrow(/shared-id/);
    });
  });
});
