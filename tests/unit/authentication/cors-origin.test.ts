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
