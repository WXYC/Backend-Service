import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('server timeout configuration', () => {
  const appSource = readFileSync(resolve(__dirname, '../../../apps/backend/app.ts'), 'utf-8');

  it('should set server timeout to at least 30 seconds', () => {
    const match = appSource.match(/server\.setTimeout\((\d+)\)/);
    expect(match).not.toBeNull();

    const timeoutMs = Number(match![1]);
    expect(timeoutMs).toBeGreaterThanOrEqual(30_000);
  });
});
