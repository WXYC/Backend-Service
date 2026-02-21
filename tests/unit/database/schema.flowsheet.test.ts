import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('flowsheet schema', () => {
  const schemaSource = readFileSync(
    resolve(__dirname, '../../../shared/database/src/schema.ts'),
    'utf-8',
  );

  it('play_order should not use serial (it is manually managed)', () => {
    const playOrderLine = schemaSource
      .split('\n')
      .find((line) => line.includes('play_order'));

    expect(playOrderLine).toBeDefined();
    expect(playOrderLine).not.toMatch(/serial\s*\(\s*['"]play_order['"]\s*\)/);
  });
});
