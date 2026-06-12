import { buildLoginPage } from '../../../shared/authentication/src/oidc-login-page';

// All happy-path / fallback tests pin NODE_ENV explicitly. The helper
// fail-louds on any value of NODE_ENV other than 'development' or 'test',
// which means `buildLoginPage({ FRONTEND_SOURCE: ... })` without a NODE_ENV
// would throw the production guard. Tests are explicit so a future reader
// understands which branch each case exercises.
const DEV = { NODE_ENV: 'development' } as const;
const TEST = { NODE_ENV: 'test' } as const;
const PROD = { NODE_ENV: 'production' } as const;

describe('buildLoginPage', () => {
  describe('happy path', () => {
    it('builds the login page URL from FRONTEND_SOURCE', () => {
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org' })).toBe('https://dj.wxyc.org/login');
    });

    it('preserves a non-default port on FRONTEND_SOURCE', () => {
      // Devs sometimes run dj-site on a non-default port. `new URL().origin`
      // keeps the port; if a future refactor switched to `.host` or string
      // concat, port-preservation would silently regress.
      expect(buildLoginPage({ ...DEV, FRONTEND_SOURCE: 'http://localhost:3001' })).toBe('http://localhost:3001/login');
    });

    it('accepts http: as well as https:', () => {
      // Local dev (and the e2e docker network) speak http; only http and
      // https are accepted, every other scheme is rejected.
      expect(buildLoginPage({ ...DEV, FRONTEND_SOURCE: 'http://e2e-frontend:3000' })).toBe(
        'http://e2e-frontend:3000/login'
      );
    });
  });

  describe('paste-from-browser hardening (only origin survives)', () => {
    // FRONTEND_SOURCE is documented as a base URL, but operators routinely
    // paste a deeper URL from a browser tab. `new URL(raw).origin` drops
    // every part of the input except scheme/host/port, so a stray path /
    // query / fragment can't poison the OIDC redirect target.

    it('strips a single trailing slash', () => {
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org/' })).toBe('https://dj.wxyc.org/login');
    });

    it('strips multiple trailing slashes', () => {
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org///' })).toBe('https://dj.wxyc.org/login');
    });

    it('discards an embedded path', () => {
      // Operator copies the actual login URL into the env var. Two distinct
      // path shapes asserted separately so a regression in either origin
      // extraction OR `/login` appending points at the right behavior.
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org/dashboard/playlists' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('discards an embedded /login path (no /login/login)', () => {
      // Separate `it` block so a refactor that silently broke origin
      // extraction (returning `parsed.toString()` instead of
      // `parsed.origin + '/login'`) would point only at the wrong invariant.
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org/login' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('discards a trailing query string', () => {
      // Paste-from-browser with a `?utm_source=...` query: without `new
      // URL().origin` this would concatenate `/login` into the query value
      // and the OIDC query better-auth appends would land after a second `?`.
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org/?utm_source=docs' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('discards a trailing fragment', () => {
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://dj.wxyc.org#frag' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('strips embedded credentials', () => {
      // `new URL('https://user:pass@host').origin` is `'https://host'`. Test
      // pins the behavior so a future refactor that switched to `.href` or
      // `.toString()` (which would leak the creds back into the redirect
      // target) would fail loud.
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'https://user:pass@dj.wxyc.org' })).toBe(
        'https://dj.wxyc.org/login'
      );
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(buildLoginPage({ ...PROD, FRONTEND_SOURCE: '  https://dj.wxyc.org  ' })).toBe('https://dj.wxyc.org/login');
    });
  });

  describe('dev-like fallback (NODE_ENV in {development, test})', () => {
    it('falls back to localhost when FRONTEND_SOURCE is unset under NODE_ENV=test', () => {
      expect(buildLoginPage(TEST)).toBe('http://localhost:3000/login');
    });

    it('falls back to localhost when FRONTEND_SOURCE is unset under NODE_ENV=development', () => {
      expect(buildLoginPage(DEV)).toBe('http://localhost:3000/login');
    });

    it('falls back when FRONTEND_SOURCE is an empty string', () => {
      // `dotenvx` and shell `export VAR=` both produce an empty string rather
      // than `undefined`.
      expect(buildLoginPage({ ...DEV, FRONTEND_SOURCE: '' })).toBe('http://localhost:3000/login');
    });

    it('falls back when FRONTEND_SOURCE is whitespace-only', () => {
      // Trailing newlines or spaces from `.env` parsers are truthy under `||`
      // but mean nothing. Trim before the empty-check so this collapses to
      // the dev fallback instead of returning ` /login`.
      expect(buildLoginPage({ ...DEV, FRONTEND_SOURCE: '   ' })).toBe('http://localhost:3000/login');
    });
  });

  describe('production-shaped fail-loud (any NODE_ENV outside {development, test})', () => {
    // Falling back to localhost in prod silently breaks SSO for every
    // unauthenticated user. The polarity is inverted relative to the
    // straw-man `=== 'production'` check so an unset NODE_ENV (the
    // BS#1097 scenario) also throws.

    it('throws when FRONTEND_SOURCE is unset under NODE_ENV=production', () => {
      expect(() => buildLoginPage(PROD)).toThrow(
        /FRONTEND_SOURCE must be set when NODE_ENV is not development or test/
      );
    });

    it('throws when FRONTEND_SOURCE is unset under NODE_ENV=staging', () => {
      // Repo runs no staging deploy today, but the polarity must protect any
      // non-dev environment a future operator stands up.
      expect(() => buildLoginPage({ NODE_ENV: 'staging' })).toThrow(
        /FRONTEND_SOURCE must be set when NODE_ENV is not development or test/
      );
    });

    it('throws when FRONTEND_SOURCE is unset and NODE_ENV is unset entirely', () => {
      // Mirrors the BS#1097 incident shape: NODE_ENV missing on EC2 + dev
      // hatch silently active in prod. Here, unset NODE_ENV must NOT enable
      // the dev fallback.
      expect(() => buildLoginPage({})).toThrow(/FRONTEND_SOURCE must be set when NODE_ENV is not development or test/);
    });

    it('throws when FRONTEND_SOURCE is empty in production', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: '' })).toThrow(
        /FRONTEND_SOURCE must be set when NODE_ENV is not development or test/
      );
    });

    it('throws when FRONTEND_SOURCE is whitespace-only in production', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: '   ' })).toThrow(
        /FRONTEND_SOURCE must be set when NODE_ENV is not development or test/
      );
    });
  });

  describe('invalid URL', () => {
    // Better-auth's authorize endpoint concatenates loginPage into a Location
    // header without re-parsing, so a malformed value silently produces a bad
    // 302. Throwing at module-load makes the misconfiguration loud.

    it('throws when FRONTEND_SOURCE has no scheme', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'dj.wxyc.org' })).toThrow(/not a valid URL/);
    });

    it('throws when FRONTEND_SOURCE is not a URL at all', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'not a url' })).toThrow(/not a valid URL/);
    });

    it("does not echo the env value into the 'not a valid URL' message", () => {
      // Operators sometimes paste URLs that embed session tokens (e.g. a
      // copied browser URL with `?session=...`). Echoing the raw env value
      // into the throw would land it in Sentry + CloudWatch indefinitely.
      try {
        buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'malformed?token=eyJhbGc-secret' });
        fail('expected throw');
      } catch (e) {
        expect((e as Error).message).not.toContain('eyJhbGc-secret');
        expect((e as Error).message).not.toContain('malformed?token');
      }
    });
  });

  describe('disallowed schemes (http: / https: only)', () => {
    // `new URL('mailto:...')` and other non-special schemes parse
    // successfully but `parsed.origin` returns the literal string 'null',
    // producing a useless 'null/login' redirect target. Reject explicitly
    // so the bad config surfaces at boot instead of in user-facing 302s.

    it('throws on mailto:', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'mailto:admin@wxyc.org' })).toThrow(
        /must use http: or https:/
      );
    });

    it('throws on file:', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'file:///etc/passwd' })).toThrow(
        /must use http: or https:/
      );
    });

    it('throws on javascript:', () => {
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'javascript:alert(1)' })).toThrow(
        /must use http: or https:/
      );
    });

    it('throws on ws:', () => {
      // WebSocket scheme is real and parseable but not valid for a redirect.
      expect(() => buildLoginPage({ ...PROD, FRONTEND_SOURCE: 'ws://dj.wxyc.org' })).toThrow(
        /must use http: or https:/
      );
    });
  });
});
