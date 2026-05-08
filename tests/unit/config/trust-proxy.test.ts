import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Express trust proxy configuration', () => {
  it.each([
    ['backend', '../../../apps/backend/app.ts'],
    ['auth', '../../../apps/auth/app.ts'],
  ])('%s app enables trust proxy so req.ip reflects the real client IP behind a reverse proxy', (_app, relPath) => {
    const appSource = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(appSource).toMatch(/app\.set\(\s*['"]trust proxy['"]/);
  });
});
