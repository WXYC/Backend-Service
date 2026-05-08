import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `instrument.ts` is a separate entry so it can be loaded via
  // `node --import ./dist/instrument.js dist/app.js`. Under ESM, all top-level
  // imports in `app.ts` are hoisted before its body runs, so a static
  // `import './instrument.js'` would resolve `express` before `Sentry.init`
  // could install its monkey-patches. `--import` runs the file before any
  // other module graph entry is evaluated.
  entry: ['app.ts', 'instrument.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    '@wxyc/database',
    'better-auth',
    'drizzle-orm',
    'express',
    'express-rate-limit',
    'cors',
    'postgres',
    '@sentry/node',
  ],
  onSuccess: options.watch ? 'node --import ./dist/instrument.js ./dist/app.js' : undefined,
}));
