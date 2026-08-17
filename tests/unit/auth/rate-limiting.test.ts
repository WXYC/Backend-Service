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
});
