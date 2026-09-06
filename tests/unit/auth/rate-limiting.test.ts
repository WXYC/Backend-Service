import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Auth service rate limiting', () => {
  const authAppSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');

  it('imports express-rate-limit', () => {
    expect(authAppSource).toMatch(/express-rate-limit/);
  });

  it('configures a rate limiter with rateLimit()', () => {
    expect(authAppSource).toMatch(/rateLimit\s*\(/);
  });

  it('applies rate limiting to sensitive auth endpoints in production', () => {
    // The rate limiter targets specific mutation paths, not all /auth routes.
    expect(authAppSource).toMatch(/authMutationRateLimit/);
    expect(authAppSource).toMatch(/\/auth\/sign-in/);
    expect(authAppSource).toMatch(/\/auth\/sign-up/);
    expect(authAppSource).toMatch(/\/auth\/email-otp\/send-verification-otp/);
    expect(authAppSource).toMatch(/\/auth\/forget-password/);
  });

  it('disables rate limiting in test environments', () => {
    expect(authAppSource).toMatch(/isTestEnv/);
    expect(authAppSource).toMatch(/NODE_ENV.*test|USE_MOCK_SERVICES/);
  });

  // BS#2169. GET /auth/get-session carries TWO limiters, not one: an
  // IP-keyed abuse ceiling plus an identity-keyed fairness limiter. The
  // ceiling is a security requirement, not an optimization — see "Why the
  // second limiter is not optional" in plans/bs2169-get-session-limiter-key.md.
  // Neither the cookie nor the bearer token is verified at keyGenerator
  // time, so identity keying alone lets a caller mint a fresh bucket on
  // every request with a fabricated credential while still costing the
  // auth service a DB session lookup. isTestEnv disables the mounted
  // middleware entirely, so a source-text assertion is the only way to pin
  // that a future "simplification" dropping the ceiling fails CI.
  it('mounts both the IP-keyed abuse ceiling and the identity-keyed fairness limiter on /auth/get-session', () => {
    expect(authAppSource).toMatch(/getSessionIpRateLimit/);
    expect(authAppSource).toMatch(/getSessionIdentityRateLimit/);
    expect(authAppSource).toMatch(
      /app\.use\(\s*['"]\/auth\/get-session['"]\s*,\s*getSessionIpRateLimit\s*,\s*getSessionIdentityRateLimit\s*\)/
    );
  });

  // BS#2361. Two properties, and the source text is the only place to pin
  // either: isTestEnv disables every mounted limiter, so nothing exercises
  // this configuration at runtime in the suite.
  //
  //   1. The dedicated limiter is 60s/120 on the exact path, keyed by
  //      rateLimitKeyFromRequest. Anything tighter locks out the whole
  //      control room, which shares one IP.
  //   2. The path is NOT in `rateLimitedPaths`. That tier is 10 per 15
  //      minutes; three DJs fumbling a hand-copied code would take the
  //      station off the signup path for a quarter of an hour with no
  //      manager on site (issue body, "Do not add this to rateLimitedPaths").
  describe('station signup (BS#2361)', () => {
    it('mounts its own 60s/120 limiter on /auth/wxyc/station-signup, keyed by rateLimitKeyFromRequest', () => {
      expect(authAppSource).toMatch(
        /const stationSignupRateLimit = rateLimit\(\{[\s\S]*?windowMs: 60_000,[\s\S]*?limit: 120,[\s\S]*?keyGenerator: rateLimitKeyFromRequest,[\s\S]*?\}\);/
      );
      expect(authAppSource).toMatch(
        /app\.use\(\s*['"]\/auth\/wxyc\/station-signup['"]\s*,\s*stationSignupRateLimit\s*\)/
      );
    });

    it('keeps /auth/wxyc/station-signup out of the 10/15min rateLimitedPaths tier', () => {
      const tier = authAppSource.match(/const rateLimitedPaths = \[([\s\S]*?)\n {2}\];/)?.[1];
      expect(tier).toBeDefined();
      expect(tier).not.toMatch(/station-signup/);
    });

    // The route and its limiter are mounted only when the feature is on, so
    // a disabled deployment falls through to better-auth's catch-all and is
    // indistinguishable from one that never shipped the endpoint.
    it('gates both the limiter and the route on isStationSignupEnabled()', () => {
      expect(authAppSource).toMatch(
        /if \(isStationSignupEnabled\(\)\) \{[\s\S]*?const stationSignupRateLimit = rateLimit\(/
      );
      expect(authAppSource).toMatch(
        /if \(isStationSignupEnabled\(\)\) \{\s*app\.post\(\s*['"]\/auth\/wxyc\/station-signup['"]\s*,\s*stationSignupHandler\s*\);\s*\}/
      );
    });
  });
});
