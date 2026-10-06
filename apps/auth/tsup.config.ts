import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `instrument.ts` is a separate entry so it can be loaded via
  // `node --import @sentry/node/import --import ./dist/instrument.js dist/app.js`.
  // Sentry v11 instruments Express through diagnostics_channel code injected at
  // module load, not by monkey-patching after `Sentry.init`: the
  // `@sentry/node/import` hook does the injecting and must come first, and
  // `instrument.js` then subscribes (and carries the Express error filter).
  // Under ESM, all top-level imports in `app.ts` are hoisted before its body
  // runs, so a static `import './instrument.js'` would init Sentry too late;
  // `--import` runs the file before any other module graph entry is evaluated.
  // `splitting: false` bundles whatever instrument.ts imports into BOTH
  // outputs; the auth filter has no class dependencies, so that is harmless.
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
  onSuccess: options.watch
    ? 'node --import @sentry/node/import --import ./dist/instrument.js ./dist/app.js'
    : undefined,
}));
