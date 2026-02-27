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

  it('applies rate limiting to the auth handler in production', () => {
    // The rate limiter is applied conditionally: skipped in test env, active otherwise.
    // Verify the production branch wires authRateLimit before toNodeHandler(auth).
    expect(authAppSource).toMatch(/authRateLimit,\s*toNodeHandler\s*\(\s*auth\s*\)/);
  });

  it('disables rate limiting in test environments', () => {
    expect(authAppSource).toMatch(/isTestEnv/);
    expect(authAppSource).toMatch(/NODE_ENV.*test|USE_MOCK_SERVICES/);
  });
});
