import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('auth IP-header trust contract', () => {
  // better-auth's getIp reads the first matching header from
  // `advanced.ipAddress.ipAddressHeaders` (defaults to `x-forwarded-for`)
  // and trusts `value.split(',')[0].trim()` without consulting Express's
  // `trust proxy` setting. nginx appends client-supplied XFF rather than
  // replacing it, so an external caller can spoof the first slot. The
  // production nginx config (api.wxyc.org server block) authoritatively
  // sets `X-Real-IP $remote_addr` for /auth/* and /healthcheck location
  // blocks, so configuring `ipAddressHeaders: ['x-real-ip']` makes
  // better-auth ignore client-controlled XFF entirely. See
  // WXYC/Backend-Service#774.
  const appSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');
  const authDefSource = readFileSync(
    resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts'),
    'utf-8'
  );

  it('better-auth advanced.ipAddress.ipAddressHeaders pins x-real-ip (the nginx-authoritative header)', () => {
    expect(authDefSource).toMatch(/ipAddress\s*:\s*\{[^}]*ipAddressHeaders\s*:\s*\[\s*['"]x-real-ip['"]/i);
  });

  it('healthcheck loopback fetch passes X-Real-IP: 127.0.0.1 so getIp succeeds without inviting XFF spoofing', () => {
    const fetchBlock = appSource.match(/fetch\(\s*`\$\{authServiceUrl\}\/auth\/ok`[\s\S]*?\)/);
    expect(fetchBlock).not.toBeNull();
    if (!fetchBlock) return;

    expect(fetchBlock[0]).toMatch(/['"]X-Real-IP['"]\s*:\s*['"]127\.0\.0\.1['"]/i);
  });
});
