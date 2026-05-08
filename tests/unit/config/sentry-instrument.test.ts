import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Sentry instrumentation loading', () => {
  it.each([
    ['backend', '../../../apps/backend'],
    ['auth', '../../../apps/auth'],
  ])(
    '%s app loads instrument.ts via node --import so Sentry hooks Express before any import resolves',
    (_app, relPath) => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, relPath, 'package.json'), 'utf-8'));
      expect(pkg.scripts?.start).toMatch(/--import\s+\.\/dist\/instrument\.js\s+dist\/app\.js/);
    }
  );

  it.each([
    ['backend', '../../../apps/backend/app.ts'],
    ['auth', '../../../apps/auth/app.ts'],
  ])(
    '%s app.ts does not statically import instrument (ESM hoisting would defeat auto-instrumentation)',
    (_app, relPath) => {
      const appSource = readFileSync(resolve(__dirname, relPath), 'utf-8');
      expect(appSource).not.toMatch(/import\s+['"]\.\/instrument(\.js)?['"]/);
    }
  );

  it.each([
    ['backend', '../../../apps/backend/tsup.config.ts'],
    ['auth', '../../../apps/auth/tsup.config.ts'],
  ])('%s tsup config emits instrument.ts as a separate entry', (_app, relPath) => {
    const tsupSource = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(tsupSource).toMatch(/entry:\s*\[[^\]]*['"]instrument\.ts['"]/);
  });
});
