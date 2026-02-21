import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Auth service rate limiting', () => {
  const authAppSource = readFileSync(
    resolve(__dirname, '../../../apps/auth/app.ts'),
    'utf-8'
  );

  it('imports express-rate-limit', () => {
    expect(authAppSource).toMatch(/express-rate-limit/);
  });

  it('configures a rate limiter with rateLimit()', () => {
    expect(authAppSource).toMatch(/rateLimit\s*\(/);
  });

  it('applies rate limiting before the auth handler', () => {
    const rateLimitIndex = authAppSource.search(/rateLimit\s*\(/);
    const authHandlerIndex = authAppSource.search(/toNodeHandler\s*\(\s*auth\s*\)/);
    expect(rateLimitIndex).toBeGreaterThan(-1);
    expect(authHandlerIndex).toBeGreaterThan(-1);
    expect(rateLimitIndex).toBeLessThan(authHandlerIndex);
  });
});
