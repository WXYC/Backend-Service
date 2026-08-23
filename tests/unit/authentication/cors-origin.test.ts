import {
  PUBLIC_READ_CORS_ROUTES,
  isPublicReadGrant,
  resolveCorsOrigin,
  resolvePublicCorsOrigins,
} from '../../../shared/authentication/src/cors-origin';

// BS#1107: the Express-level CORS config in apps/backend/app.ts and
// apps/auth/app.ts used `origin: process.env.FRONTEND_SOURCE || '*'` next to
// `credentials: true`. With the `cors` package, `'*'` + credentials reflects
// the request's Origin header back as Access-Control-Allow-Origin alongside
// Access-Control-Allow-Credentials: true, so ANY web origin could make
// credentialed (cookie-bearing) requests whenever FRONTEND_SOURCE was unset.
// `resolveCorsOrigin` is the replacement: fail closed (`false` disables the
// cors middleware entirely — no ACAO/ACAC headers) instead of failing open.

describe('resolveCorsOrigin', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('fail-closed when unset (the BS#1107 fix)', () => {
    it('returns false when FRONTEND_SOURCE is missing', () => {
      expect(resolveCorsOrigin({})).toBe(false);
    });

    it('returns false when FRONTEND_SOURCE is an empty string', () => {
      // docker-compose passthrough (`FRONTEND_SOURCE=${FRONTEND_SOURCE}`)
      // materializes an unset host var as an empty string in the container,
      // so empty must fail closed exactly like missing.
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: '' })).toBe(false);
    });

    it('returns false when FRONTEND_SOURCE is whitespace-only', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: '   ' })).toBe(false);
    });

    it('returns false when FRONTEND_SOURCE is only commas and whitespace', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: ' , ,, ' })).toBe(false);
    });

    it('never returns the legacy wildcard', () => {
      expect(resolveCorsOrigin({})).not.toBe('*');
    });

    it('logs at error level so a misconfigured deploy is diagnosable', () => {
      resolveCorsOrigin({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('FRONTEND_SOURCE');
    });

    it('does not log when a valid origin is configured', () => {
      resolveCorsOrigin({ FRONTEND_SOURCE: 'https://dj.wxyc.org' });
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('single configured origin (existing contract preserved)', () => {
    it('returns the configured origin verbatim', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: 'https://dj.wxyc.org' })).toBe('https://dj.wxyc.org');
    });

    it('trims surrounding whitespace', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: '  http://localhost:3000 ' })).toBe('http://localhost:3000');
    });
  });

  describe('comma-separated whitelist (BETTER_AUTH_TRUSTED_ORIGINS semantics)', () => {
    it('splits a comma-separated value into a whitelist array', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: 'https://dj.wxyc.org,https://wxyc.org' })).toEqual([
        'https://dj.wxyc.org',
        'https://wxyc.org',
      ]);
    });

    it('trims each entry and drops empty segments', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: ' https://dj.wxyc.org , , https://wxyc.org, ' })).toEqual([
        'https://dj.wxyc.org',
        'https://wxyc.org',
      ]);
    });

    it('collapses a whitelist with a single surviving entry to the string form', () => {
      // The string form preserves the pre-BS#1107 header emission for
      // single-origin deploys (ACAO always carries the configured literal).
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: 'https://dj.wxyc.org,' })).toBe('https://dj.wxyc.org');
    });
  });

  describe('fallback env vars (auth service consults BETTER_AUTH_TRUSTED_ORIGINS)', () => {
    const AUTH_VARS = ['FRONTEND_SOURCE', 'BETTER_AUTH_TRUSTED_ORIGINS'];

    it('prefers the first candidate when it is set', () => {
      expect(
        resolveCorsOrigin(
          { FRONTEND_SOURCE: 'https://dj.wxyc.org', BETTER_AUTH_TRUSTED_ORIGINS: 'https://other.example' },
          AUTH_VARS
        )
      ).toBe('https://dj.wxyc.org');
    });

    it('falls back to the next candidate when the first is unset', () => {
      expect(
        resolveCorsOrigin({ BETTER_AUTH_TRUSTED_ORIGINS: 'https://dj.wxyc.org,https://wxyc.org' }, AUTH_VARS)
      ).toEqual(['https://dj.wxyc.org', 'https://wxyc.org']);
    });

    it('falls back when the first candidate is empty rather than missing', () => {
      expect(
        resolveCorsOrigin({ FRONTEND_SOURCE: '', BETTER_AUTH_TRUSTED_ORIGINS: 'https://dj.wxyc.org' }, AUTH_VARS)
      ).toBe('https://dj.wxyc.org');
    });

    it('fails closed and names every candidate when all are unset', () => {
      expect(resolveCorsOrigin({}, AUTH_VARS)).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain('FRONTEND_SOURCE');
      expect(message).toContain('BETTER_AUTH_TRUSTED_ORIGINS');
    });
  });

  // dj-site deploys to the `wxyc-dj` Cloudflare Pages project; every branch and
  // commit gets a fresh `https://<hash>.wxyc-dj.pages.dev` host that can't be
  // enumerated ahead of time, so credentialed calls from a preview fail their
  // CORS preflight before better-auth is ever reached. A wildcard entry lets
  // both trust layers accept the whole subdomain. The `cors` package treats a
  // RegExp entry as a matcher, which is what makes this work at all.
  //
  // The wildcard lives in CORS_PREVIEW_ORIGINS rather than FRONTEND_SOURCE
  // because FRONTEND_SOURCE is read as a SINGLE URL by oidc-login-page.ts,
  // url-rewrite.ts, and provision-user.ts — and a comma-joined value parses
  // there instead of throwing. See the dedicated describe block below.
  describe('wildcard preview origins (CORS_PREVIEW_ORIGINS)', () => {
    const PROD = 'https://dj.wxyc.org';
    const PREVIEW = 'https://*.wxyc-dj.pages.dev';
    const AUTH_VARS = ['FRONTEND_SOURCE', 'BETTER_AUTH_TRUSTED_ORIGINS'];
    const ENV = { FRONTEND_SOURCE: PROD, CORS_PREVIEW_ORIGINS: PREVIEW };

    /** The compiled preview matcher out of the resolved whitelist. */
    const previewOf = (env: NodeJS.ProcessEnv): RegExp => {
      const resolved = resolveCorsOrigin(env);
      if (!Array.isArray(resolved)) throw new Error(`expected an array, got ${JSON.stringify(resolved)}`);
      const pattern = resolved.find((entry): entry is RegExp => entry instanceof RegExp);
      if (!pattern) throw new Error(`no RegExp entry in ${JSON.stringify(resolved)}`);
      return pattern;
    };

    it('unions the preview onto the primary origin', () => {
      const resolved = resolveCorsOrigin(ENV);
      expect(Array.isArray(resolved)).toBe(true);
      const [prod, preview] = resolved as Array<string | RegExp>;
      expect(prod).toBe(PROD);
      expect(preview).toBeInstanceOf(RegExp);
    });

    it('matches a preview deployment host', () => {
      const pattern = previewOf(ENV);
      expect(pattern.test('https://abc123.wxyc-dj.pages.dev')).toBe(true);
      expect(pattern.test('https://feat-color-system.wxyc-dj.pages.dev')).toBe(true);
    });

    it('does not match an unrelated origin', () => {
      const pattern = previewOf(ENV);
      expect(pattern.test('https://evil.com')).toBe(false);
      expect(pattern.test('http://abc123.wxyc-dj.pages.dev')).toBe(false); // scheme differs
    });

    it('anchors the pattern so a matching prefix or suffix cannot smuggle through', () => {
      const pattern = previewOf(ENV);
      expect(pattern.test('https://abc.wxyc-dj.pages.dev.evil.com')).toBe(false);
      expect(pattern.test('https://abc.wxyc-dj.pages.dev/../evil')).toBe(false);
    });

    it('does not let `*` cross an origin separator', () => {
      // `*` matches `[^/\\]*`, so a path segment cannot satisfy the subdomain.
      expect(previewOf(ENV).test('https://x/y.wxyc-dj.pages.dev')).toBe(false);
    });

    it('lets `*` span dots, so deeper subdomains under the named zone match', () => {
      // `/` and `\` are the only separators, so `*` DOES cross dots: a
      // multi-label host under the wildcard zone is trusted. This is the
      // intended breadth — safe only because WXYC owns the whole
      // `wxyc-dj.pages.dev` zone (see `toCorsPattern`'s breadth caveat). Pinned
      // so a future tightening of the wildcard class can't silently narrow the
      // trust scope without a failing test.
      const pattern = previewOf(ENV);
      expect(pattern.test('https://a.b.wxyc-dj.pages.dev')).toBe(true);
      expect(pattern.test('https://deploy.preview.wxyc-dj.pages.dev')).toBe(true);
    });

    it('lets `*` match an empty label, still bounded to the named zone', () => {
      // `*` compiles to `[^/\\]*` (zero-or-more), so an empty subdomain label
      // matches. Unreachable from a real browser Origin, but pinned so the
      // zero-width behavior is documented rather than incidental. Crucially the
      // apex without the leading `.` still does NOT match — the literal
      // separator dot is required.
      const pattern = previewOf(ENV);
      expect(pattern.test('https://.wxyc-dj.pages.dev')).toBe(true);
      expect(pattern.test('https://wxyc-dj.pages.dev')).toBe(false);
    });

    it('treats regex metacharacters in the literal portion literally', () => {
      // The dots must be literal dots, not "any character".
      expect(previewOf(ENV).test('https://abc.wxyc-djXpages.dev')).toBe(false);
    });

    it('compiles several preview entries and keeps literals as plain strings', () => {
      const resolved = resolveCorsOrigin({
        FRONTEND_SOURCE: PROD,
        CORS_PREVIEW_ORIGINS: `${PREVIEW},https://staging.wxyc.org,https://*.preview.wxyc.org`,
      }) as Array<string | RegExp>;
      expect(resolved).toHaveLength(4);
      expect(resolved[0]).toBe(PROD);
      expect(resolved[1]).toBeInstanceOf(RegExp);
      expect(resolved[2]).toBe('https://staging.wxyc.org');
      expect(resolved[3]).toBeInstanceOf(RegExp);
    });

    it('applies to whichever primary won, not just the first name', () => {
      const resolved = resolveCorsOrigin(
        { BETTER_AUTH_TRUSTED_ORIGINS: PROD, CORS_PREVIEW_ORIGINS: PREVIEW },
        AUTH_VARS
      ) as Array<string | RegExp>;
      expect(resolved[0]).toBe(PROD);
      expect(resolved[1]).toBeInstanceOf(RegExp);
    });

    it('widens but never replaces: previews alone still fail closed', () => {
      // BS#1107's contract. A deploy that sets only the preview list is
      // misconfigured — FRONTEND_SOURCE is required by the login page and the
      // reset/invite emails regardless of CORS — so this must not open the door.
      expect(resolveCorsOrigin({ CORS_PREVIEW_ORIGINS: PREVIEW })).toBe(false);
      const messages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('CORS_PREVIEW_ORIGINS'))).toBe(true);
    });

    it('is byte-identical to the pre-existing behavior when unset', () => {
      // The bare-string form for a single origin is load-bearing: the `cors`
      // package emits a configured literal as ACAO unconditionally, whereas an
      // array is treated as a whitelist. An unset preview var must not change
      // which of those two a deploy gets.
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: PROD })).toBe(PROD);
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: PROD, CORS_PREVIEW_ORIGINS: '' })).toBe(PROD);
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: PROD, CORS_PREVIEW_ORIGINS: '  , ,' })).toBe(PROD);
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: `${PROD},https://b.wxyc.org` })).toEqual([
        PROD,
        'https://b.wxyc.org',
      ]);
    });

    it('honors a custom preview variable name', () => {
      const resolved = resolveCorsOrigin({ FRONTEND_SOURCE: PROD, OTHER: PREVIEW }, ['FRONTEND_SOURCE'], 'OTHER');
      expect((resolved as Array<string | RegExp>)[1]).toBeInstanceOf(RegExp);
    });
  });
});

// BS#2061. `website` is a static export, so the three Phase 4 listener pages on
// wxyc.org fetch api.wxyc.org straight from the browser. They need ACAO for
// wxyc.org — but NOT credentialed access to the whole API, which is what simply
// appending them to FRONTEND_SOURCE would grant (`credentials: true` sits beside
// `origin` on the single cors() mount). These helpers carve out a
// credential-less grant on the three public flowsheet reads and leave the
// credentialed dj.wxyc.org whitelist exactly as it is.
describe('public read-route CORS (BS#2061)', () => {
  const PUBLIC = ['https://wxyc.org', 'https://www.wxyc.org'];
  const DJ = 'https://dj.wxyc.org';

  function get(path: string, origin?: string) {
    return { method: 'GET', path, headers: origin ? { origin } : {} };
  }

  describe('resolvePublicCorsOrigins', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => warnSpy.mockRestore());

    it('parses a comma-separated list', () => {
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: 'https://wxyc.org,https://www.wxyc.org' })).toEqual(
        PUBLIC
      );
    });

    it('trims entries and drops empty segments', () => {
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: ' https://wxyc.org , , https://www.wxyc.org ' })).toEqual(
        PUBLIC
      );
    });

    it('returns an empty list when unset, without logging', () => {
      // Unlike FRONTEND_SOURCE, an unset value here is a legitimate steady
      // state (local dev, and prod until the D3 pages ship), so it must not
      // emit the noisy misconfiguration error resolveCorsOrigin does.
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(resolvePublicCorsOrigins({})).toEqual([]);
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: '' })).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('never honors a wildcard (BS#1107)', () => {
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: '*' })).toEqual([]);
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: 'https://wxyc.org,*' })).toEqual(['https://wxyc.org']);
    });

    // Setting this variable is a manual deploy step, so the likeliest failure
    // is a value that looks configured and matches nothing: an Origin header
    // is always a bare origin, and comparison is exact.
    it.each([
      ['https://wxyc.org/', 'trailing slash — the paste-from-browser form'],
      ['https://wxyc.org/playlists', 'a path'],
      ['https://WXYC.org', 'mixed-case host'],
      ['https://wxyc.org?x=1', 'a query string'],
    ])('normalizes %s (%s) to the bare origin', (value) => {
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: value })).toEqual(['https://wxyc.org']);
    });

    it('warns when it had to normalize, naming the value', () => {
      resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: 'https://wxyc.org/' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('https://wxyc.org/');
    });

    it('does not warn when every entry is already a bare origin', () => {
      resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: 'https://wxyc.org,https://www.wxyc.org' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('drops unparseable and non-http(s) entries, keeping the good ones', () => {
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: 'wxyc.org,mailto:dj@wxyc.org,https://wxyc.org' })).toEqual(
        ['https://wxyc.org']
      );
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('de-duplicates entries that normalize to the same origin', () => {
      expect(resolvePublicCorsOrigins({ PUBLIC_READ_ORIGINS: 'https://wxyc.org,https://wxyc.org/' })).toEqual([
        'https://wxyc.org',
      ]);
    });
  });

  describe('isPublicReadGrant', () => {
    it('grants a listed public origin on each public route', () => {
      for (const path of PUBLIC_READ_CORS_ROUTES) {
        expect(isPublicReadGrant(get(path, 'https://wxyc.org'), PUBLIC)).toBe(true);
      }
    });

    it('covers the three Phase 4 consumer routes and nothing else', () => {
      expect([...PUBLIC_READ_CORS_ROUTES].sort()).toEqual(['/flowsheet', '/flowsheet/range', '/flowsheet/search']);
    });

    it('tolerates a trailing slash', () => {
      expect(isPublicReadGrant(get('/flowsheet/', 'https://wxyc.org'), PUBLIC)).toBe(true);
    });

    it('matches case-insensitively, because the Express router does', () => {
      // `case sensitive routing` is off by default and app.ts never enables
      // it, so /Flowsheet/Search reaches the same handler. Matching
      // case-sensitively here would serve a 200 the browser discards.
      expect(isPublicReadGrant(get('/Flowsheet/Search', 'https://wxyc.org'), PUBLIC)).toBe(true);
    });

    it('does not grant dj.wxyc.org — it keeps the credentialed contract', () => {
      expect(isPublicReadGrant(get('/flowsheet/search', DJ), PUBLIC)).toBe(false);
    });

    it('does not grant a request with no Origin header — non-browser clients are unaffected', () => {
      expect(isPublicReadGrant(get('/flowsheet'), PUBLIC)).toBe(false);
    });

    it('does not grant an unlisted origin', () => {
      expect(isPublicReadGrant(get('/flowsheet', 'https://evil.example'), PUBLIC)).toBe(false);
    });

    it('does not extend beyond the three routes', () => {
      for (const path of ['/library', '/flowsheet/latest', '/flowsheet/playlist', '/concerts']) {
        expect(isPublicReadGrant(get(path, 'https://wxyc.org'), PUBLIC)).toBe(false);
      }
    });

    it('does not let a public-route prefix match a deeper or longer path', () => {
      for (const path of ['/flowsheet/search/extra', '/flowsheetXYZ', '/flowsheet/rangeXYZ']) {
        expect(isPublicReadGrant(get(path, 'https://wxyc.org'), PUBLIC)).toBe(false);
      }
    });

    it('is read-only — a mutation from a public origin is not granted', () => {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const req = { method, path: '/flowsheet', headers: { origin: 'https://wxyc.org' } };
        expect(isPublicReadGrant(req, PUBLIC)).toBe(false);
      }
    });

    it('grants a GET preflight but not a mutation preflight', () => {
      const preflight = (requested: string) => ({
        method: 'OPTIONS',
        path: '/flowsheet/range',
        headers: { origin: 'https://wxyc.org', 'access-control-request-method': requested },
      });
      expect(isPublicReadGrant(preflight('GET'), PUBLIC)).toBe(true);
      expect(isPublicReadGrant(preflight('POST'), PUBLIC)).toBe(false);
    });

    it('grants nothing when no public origins are configured', () => {
      expect(isPublicReadGrant(get('/flowsheet', 'https://wxyc.org'), [])).toBe(false);
    });
  });
});
