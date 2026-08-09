import {
  PUBLIC_READ_CORS_ROUTES,
  resolveCorsMode,
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
  });

  describe('resolveCorsMode', () => {
    it('grants a listed public origin a credential-less read on each public route', () => {
      for (const path of PUBLIC_READ_CORS_ROUTES) {
        const mode = resolveCorsMode(get(path, 'https://wxyc.org'), PUBLIC, DJ);
        expect(mode).toEqual({ origin: PUBLIC, credentials: false });
      }
    });

    it('covers the three Phase 4 consumer routes and nothing else', () => {
      expect([...PUBLIC_READ_CORS_ROUTES].sort()).toEqual(['/flowsheet', '/flowsheet/range', '/flowsheet/search']);
    });

    it('tolerates a trailing slash', () => {
      expect(resolveCorsMode(get('/flowsheet/', 'https://wxyc.org'), PUBLIC, DJ).credentials).toBe(false);
    });

    it('leaves dj.wxyc.org credentialed on the same routes', () => {
      const mode = resolveCorsMode(get('/flowsheet/search', DJ), PUBLIC, DJ);
      expect(mode).toEqual({ origin: DJ, credentials: true });
    });

    it('leaves a request with no Origin header untouched — non-browser clients are unaffected', () => {
      expect(resolveCorsMode(get('/flowsheet'), PUBLIC, DJ)).toEqual({ origin: DJ, credentials: true });
    });

    it('never echoes an unlisted origin', () => {
      const mode = resolveCorsMode(get('/flowsheet', 'https://evil.example'), PUBLIC, DJ);
      expect(mode).toEqual({ origin: DJ, credentials: true });
      expect(mode.origin).not.toBe('https://evil.example');
    });

    it('does not extend the public grant beyond the three routes', () => {
      for (const path of ['/library', '/flowsheet/latest', '/flowsheet/playlist', '/concerts']) {
        expect(resolveCorsMode(get(path, 'https://wxyc.org'), PUBLIC, DJ)).toEqual({ origin: DJ, credentials: true });
      }
    });

    it('does not let a public-route prefix match a deeper or longer path', () => {
      for (const path of ['/flowsheet/search/extra', '/flowsheetXYZ', '/flowsheet/rangeXYZ']) {
        expect(resolveCorsMode(get(path, 'https://wxyc.org'), PUBLIC, DJ).credentials).toBe(true);
      }
    });

    it('is read-only — a mutation from a public origin stays on the credentialed branch', () => {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const req = { method, path: '/flowsheet', headers: { origin: 'https://wxyc.org' } };
        expect(resolveCorsMode(req, PUBLIC, DJ)).toEqual({ origin: DJ, credentials: true });
      }
    });

    it('grants a GET preflight but not a mutation preflight', () => {
      const preflight = (requested: string) => ({
        method: 'OPTIONS',
        path: '/flowsheet/range',
        headers: { origin: 'https://wxyc.org', 'access-control-request-method': requested },
      });
      expect(resolveCorsMode(preflight('GET'), PUBLIC, DJ).credentials).toBe(false);
      expect(resolveCorsMode(preflight('POST'), PUBLIC, DJ).credentials).toBe(true);
    });

    it('falls back to the credentialed branch when no public origins are configured', () => {
      expect(resolveCorsMode(get('/flowsheet', 'https://wxyc.org'), [], DJ)).toEqual({ origin: DJ, credentials: true });
    });

    it('still serves the public pages when FRONTEND_SOURCE itself is unset', () => {
      // The two configs are independent: a deploy that fails closed on the
      // credentialed origin must not also take down the anonymous listener
      // pages, and vice versa.
      expect(resolveCorsMode(get('/flowsheet', 'https://wxyc.org'), PUBLIC, false)).toEqual({
        origin: PUBLIC,
        credentials: false,
      });
      expect(resolveCorsMode(get('/flowsheet', DJ), PUBLIC, false)).toEqual({ origin: false, credentials: true });
    });
  });
});
