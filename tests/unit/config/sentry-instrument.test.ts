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

  // v11 captures Express errors (and consults `shouldHandleError`) through
  // diagnostics_channel code injected at module load. Without this hook ahead
  // of instrument.js, Sentry logs "No diagnostics-channel injection detected"
  // and no Express error is captured at all (BS#2949).
  it.each([
    ['backend', '../../../apps/backend'],
    ['auth', '../../../apps/auth'],
    ['enrichment-worker', '../../../apps/enrichment-worker'],
  ])('%s start script registers the v11 injection hook before instrument.js', (_app, relPath) => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, relPath, 'package.json'), 'utf-8'));
    expect(pkg.scripts?.start).toMatch(/--import\s+@sentry\/node\/import\s+--import\s+\.\/dist\/instrument\.js/);
  });

  // ESM evaluates every import before the module body, so a `config()` call in
  // the body runs after the filter's imports have read the environment. The
  // backend filter pulls in @wxyc/lml-client, whose limiter and timeout
  // constants are fixed at module load, so .env must load as the first import.
  it.each([
    ['backend', '../../../apps/backend/instrument.ts'],
    ['auth', '../../../apps/auth/instrument.ts'],
  ])('%s instrument.ts loads .env as its first import', (_app, relPath) => {
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    const firstImport = source.match(/^import\s.*$/m)?.[0];
    expect(firstImport).toBe("import 'dotenv/config';");
  });

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

  // `splitting: false` gives instrument.js and app.js each their own copy of
  // every bundled module, so the preload's `instanceof LmlClientError` only
  // matches errors thrown from app.js while lml-client stays external and both
  // bundles import the one installed copy.
  it.each([
    ['backend', '../../../apps/backend/tsup.config.ts'],
    ['enrichment-worker', '../../../apps/enrichment-worker/tsup.config.ts'],
  ])('%s tsup config keeps @wxyc/lml-client external', (_app, relPath) => {
    const tsupSource = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(tsupSource).toMatch(/external:\s*\[[^\]]*['"]@wxyc\/lml-client['"]/);
  });

  it.each([
    ['backend', '../../../apps/backend/tsup.config.ts'],
    ['auth', '../../../apps/auth/tsup.config.ts'],
  ])('%s tsup config emits instrument.ts as a separate entry', (_app, relPath) => {
    const tsupSource = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(tsupSource).toMatch(/entry:\s*\[[^\]]*['"]instrument\.ts['"]/);
  });
});
