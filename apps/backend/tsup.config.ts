import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the directory where this config file is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  // outputs, so classes the filter checks must not rely on `instanceof`
  // (see `isWxycError`).
  entry: ['app.ts', 'instrument.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // `sns-validator` is CJS-only; bundling it into ESM produces a `Dynamic
  // require of "sns-validator" is not supported` at runtime. Mark external
  // so Node's CJS↔ESM interop resolves it through node_modules.
  // `@wxyc/lml-client` is external on purpose, not just because it is a
  // dependency: the preload's Sentry filter checks `instanceof LmlClientError`
  // against errors thrown from app.js, which only holds while both bundles
  // import the one installed copy of the class (BS#2949).
  external: ['@sentry/node', 'sns-validator', '@wxyc/lml-client'],
  onSuccess: options.watch
    ? 'node --import @sentry/node/import --import ./dist/instrument.js ./dist/app.js'
    : undefined,
  minify: !options.watch,

  loader: {
    '.yaml': 'text',
  },

  esbuildOptions(options) {
    // Resolve @/ alias to the directory where this config file is located
    // This matches TypeScript's behavior (relative to tsconfig.json location)
    options.alias = {
      '@': resolve(__dirname),
    };
  },
}));
