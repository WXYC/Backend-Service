import { buildLoginPage } from '../../../shared/authentication/src/oidc-login-page';

describe('buildLoginPage', () => {
  it('builds the login page URL from FRONTEND_SOURCE', () => {
    expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org' })).toBe('https://dj.wxyc.org/login');
  });

  it('strips a trailing slash on FRONTEND_SOURCE before appending /login', () => {
    // The dev `.env.example` shows FRONTEND_SOURCE without a trailing slash,
    // but operators routinely paste a copy-from-browser URL with one. A
    // doubled slash (`https://dj.wxyc.org//login`) silently breaks the
    // round-trip when better-auth's authorize endpoint redirects here.
    expect(buildLoginPage({ FRONTEND_SOURCE: 'https://dj.wxyc.org/' })).toBe('https://dj.wxyc.org/login');
  });

  it('falls back to http://localhost:3000/login when FRONTEND_SOURCE is unset', () => {
    // Mirrors the default in `rewriteUrlForFrontend` so a fresh-clone dev
    // setup with no .env still completes the OIDC round-trip against the
    // dj-site dev server on port 3000.
    expect(buildLoginPage({})).toBe('http://localhost:3000/login');
  });

  it('falls back to the localhost default when FRONTEND_SOURCE is an empty string', () => {
    // `dotenvx` and shell `export VAR=` both produce an empty string rather
    // than `undefined`. Treat empty-string the same as unset so the dev
    // default still applies.
    expect(buildLoginPage({ FRONTEND_SOURCE: '' })).toBe('http://localhost:3000/login');
  });
});
