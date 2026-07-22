import { resolveCorsOrigin } from '../../../shared/authentication/src/cors-origin';

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

  describe('wildcard preview origins (dj-site Cloudflare Pages previews)', () => {
    // dj-site deploys to the `wxyc-dj` Cloudflare Pages project; every branch /
    // commit gets a fresh `https://<hash>.wxyc-dj.pages.dev` host that can't be
    // enumerated ahead of time. A wildcard entry lets both trust layers accept
    // the whole subdomain so the frontend can live-preview against the real
    // backend. The `cors` package treats a RegExp entry as a matcher.
    const previewOf = (env: NodeJS.ProcessEnv) => {
      const resolved = resolveCorsOrigin(env);
      if (!(resolved instanceof RegExp)) throw new Error(`expected a RegExp, got ${JSON.stringify(resolved)}`);
      return resolved;
    };

    it('compiles a single wildcard entry to a RegExp', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' })).toBeInstanceOf(RegExp);
    });

    it('matches a preview deployment host', () => {
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      expect(pattern.test('https://abc123.wxyc-dj.pages.dev')).toBe(true);
      expect(pattern.test('https://feat-color-system.wxyc-dj.pages.dev')).toBe(true);
    });

    it('does not match an unrelated origin', () => {
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      expect(pattern.test('https://evil.com')).toBe(false);
      expect(pattern.test('http://abc123.wxyc-dj.pages.dev')).toBe(false); // scheme differs
    });

    it('anchors the pattern so a matching prefix or suffix cannot smuggle through', () => {
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      expect(pattern.test('https://abc.wxyc-dj.pages.dev.evil.com')).toBe(false);
      expect(pattern.test('https://abc.wxyc-dj.pages.dev/../evil')).toBe(false);
    });

    it('does not let `*` cross an origin separator', () => {
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      // `*` matches `[^/\\]*`, so a path segment cannot satisfy the subdomain.
      expect(pattern.test('https://x/y.wxyc-dj.pages.dev')).toBe(false);
    });

    it('lets `*` span dots, so deeper subdomains under the named zone match', () => {
      // `/` and `\` are the only separators, so `*` DOES cross dots: a
      // multi-label host under the wildcard zone is trusted. This is the
      // intended breadth — safe only because WXYC owns the whole
      // `wxyc-dj.pages.dev` zone (see `toCorsPattern`'s breadth caveat). Pin it
      // so a future tightening of the wildcard class can't silently narrow the
      // trust scope without a failing test.
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      expect(pattern.test('https://a.b.wxyc-dj.pages.dev')).toBe(true);
      expect(pattern.test('https://deploy.preview.wxyc-dj.pages.dev')).toBe(true);
    });

    it('lets `*` match an empty label (zero-width), still bounded to the named zone', () => {
      // `*` compiles to `[^/\\]*` (zero-or-more), so an empty subdomain label
      // matches. Unreachable from a real browser Origin, but pinned so the
      // zero-width behavior is documented rather than incidental. Crucially,
      // the apex without the leading `.` still does NOT match — the literal
      // separator dot is required.
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      expect(pattern.test('https://.wxyc-dj.pages.dev')).toBe(true);
      expect(pattern.test('https://wxyc-dj.pages.dev')).toBe(false);
    });

    it('treats the regex metacharacters in the literal portion literally', () => {
      // The dots must be literal dots, not "any character".
      const pattern = previewOf({ FRONTEND_SOURCE: 'https://*.wxyc-dj.pages.dev' });
      expect(pattern.test('https://abc.wxyc-djXpages.dev')).toBe(false);
    });

    it('mixes literal and wildcard entries in a whitelist', () => {
      const resolved = resolveCorsOrigin({
        FRONTEND_SOURCE: 'https://dj.wxyc.org,https://*.wxyc-dj.pages.dev',
      });
      expect(Array.isArray(resolved)).toBe(true);
      const [prod, preview] = resolved as Array<string | RegExp>;
      expect(prod).toBe('https://dj.wxyc.org');
      expect(preview).toBeInstanceOf(RegExp);
      expect((preview as RegExp).test('https://abc123.wxyc-dj.pages.dev')).toBe(true);
    });

    it('leaves a literal single origin as a plain string (no RegExp)', () => {
      expect(resolveCorsOrigin({ FRONTEND_SOURCE: 'https://dj.wxyc.org' })).toBe('https://dj.wxyc.org');
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
});
