import { buildLoginPage } from '../../../shared/authentication/src/oidc-login-page';

describe('buildLoginPage', () => {
  describe('happy path', () => {
    it('builds the login page URL from FRONTEND_SOURCE', () => {
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org' })).toBe('https://dj.wxyc.org/login');
    });

    it('preserves a non-default port on FRONTEND_SOURCE', () => {
      // Devs sometimes run dj-site on a non-default port. `new URL().origin`
      // keeps the port; if a future refactor switched to `.host` or string
      // concat, port-preservation would silently regress.
      expect(buildLoginPage({ FRONTEND_SOURCE: 'http://localhost:3001' })).toBe('http://localhost:3001/login');
    });
  });

  describe('paste-from-browser hardening (only origin survives)', () => {
    // FRONTEND_SOURCE is documented as a base URL, but operators routinely
    // paste a deeper URL from a browser tab. `new URL(raw).origin` drops
    // every part of the input except scheme/host/port, so a stray path /
    // query / fragment can't poison the OIDC redirect target.

    it('strips a single trailing slash', () => {
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org/' })).toBe('https://dj.wxyc.org/login');
    });

    it('strips multiple trailing slashes', () => {
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org///' })).toBe('https://dj.wxyc.org/login');
    });

    it('discards an embedded path', () => {
      // Operator copies the actual login URL into the env var.
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org/login' })).toBe('https://dj.wxyc.org/login');
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org/dashboard/playlists' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('discards a trailing query string', () => {
      // Paste-from-browser with a `?utm_source=...` query: without `new
      // URL().origin` this would concatenate `/login` into the query value
      // and the OIDC query better-auth appends would land after a second `?`.
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org/?utm_source=docs' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('discards a trailing fragment', () => {
      expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org#frag' })).toBe('https://dj.wxyc.org/login');
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(buildLoginPage({ FRONTEND_SOURCE: '  https://dj.wxyc.org  ' })).toBe('https://dj.wxyc.org/login');
    });
  });

  describe('dev fallback (NODE_ENV !== production)', () => {
    it('falls back to localhost when FRONTEND_SOURCE is unset', () => {
      expect(buildLoginPage({})).toBe('http://localhost:3000/login');
    });

    it('falls back when FRONTEND_SOURCE is an empty string', () => {
      // `dotenvx` and shell `export VAR=` both produce an empty string rather
      // than `undefined`.
      expect(buildLoginPage({ FRONTEND_SOURCE: '' })).toBe('http://localhost:3000/login');
    });

    it('falls back when FRONTEND_SOURCE is whitespace-only', () => {
      // Trailing newlines or spaces from `.env` parsers are truthy under `||`
      // but mean nothing. Trim before the empty-check so this collapses to
      // the dev fallback instead of returning ` /login`.
      expect(buildLoginPage({ FRONTEND_SOURCE: '   ' })).toBe('http://localhost:3000/login');
    });

    it('falls back when NODE_ENV is explicitly development', () => {
      expect(buildLoginPage({ NODE_ENV: 'development' })).toBe('http://localhost:3000/login');
    });
  });

  describe('production fail-loud', () => {
    // In prod, falling back to localhost silently breaks SSO for every
    // unauthenticated user. The peer pattern in `oidc-trusted-clients.ts`
    // refuses to register clients with incomplete env; this throws.

    it('throws when FRONTEND_SOURCE is unset in production', () => {
      expect(() => buildLoginPage({ NODE_ENV: 'production' })).toThrow(/FRONTEND_SOURCE must be set in production/);
    });

    it('throws when FRONTEND_SOURCE is empty in production', () => {
      expect(() => buildLoginPage({ NODE_ENV: 'production', FRONTEND_SOURCE: '' })).toThrow(
        /FRONTEND_SOURCE must be set in production/
      );
    });

    it('throws when FRONTEND_SOURCE is whitespace-only in production', () => {
      expect(() => buildLoginPage({ NODE_ENV: 'production', FRONTEND_SOURCE: '   ' })).toThrow(
        /FRONTEND_SOURCE must be set in production/
      );
    });
  });

  describe('invalid URL', () => {
    // Better-auth's authorize endpoint concatenates loginPage into a Location
    // header without re-parsing, so a malformed value silently produces a bad
    // 302. Throwing at module-load makes the misconfiguration loud.

    it('throws when FRONTEND_SOURCE has no scheme', () => {
      expect(() => buildLoginPage({ FRONTEND_SOURCE: 'dj.wxyc.org' })).toThrow(/not a valid URL/);
    });

    it('throws when FRONTEND_SOURCE is not a URL at all', () => {
      expect(() => buildLoginPage({ FRONTEND_SOURCE: 'not a url' })).toThrow(/not a valid URL/);
    });
  });
});
