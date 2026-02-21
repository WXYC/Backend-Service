import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Express trust proxy configuration', () => {
  const appSource = readFileSync(resolve(__dirname, '../../../apps/backend/app.ts'), 'utf-8');

  it('should enable trust proxy so req.ip reflects the real client IP behind a reverse proxy', () => {
    expect(appSource).toMatch(/app\.set\(\s*['"]trust proxy['"]/);
  });
});
