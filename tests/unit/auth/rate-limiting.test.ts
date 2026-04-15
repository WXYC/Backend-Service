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
});
