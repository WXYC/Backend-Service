import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('auth /healthcheck loopback', () => {
  // The loopback fetch at apps/auth/app.ts has no real client; without an
  // X-Forwarded-For header better-auth's getIp returns null in production
  // and latches "Rate limiting skipped: could not determine client IP" once
  // per process. See WXYC/Backend-Service#765.
  const appSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');

  it('passes X-Forwarded-For: 127.0.0.1 on the loopback /auth/ok fetch', () => {
    const fetchBlock = appSource.match(/fetch\(\s*`\$\{authServiceUrl\}\/auth\/ok`[\s\S]*?\)/);
    expect(fetchBlock).not.toBeNull();
    if (!fetchBlock) return;

    expect(fetchBlock[0]).toMatch(/['"]X-Forwarded-For['"]\s*:\s*['"]127\.0\.0\.1['"]/i);
  });
});
