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
  // `splitting: true` emits every module both entries reach (utils/error.ts,
  // errorHandler.ts, sentryErrorFilter.ts) once, in a chunk that both import,
  // so the process holds one copy of each app-defined class and `instanceof`
  // against it gives the same answer in the preload and in app.js. With
  // `splitting: false` each output got its own copy of these modules (BS#2975).
  entry: ['app.ts', 'instrument.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // With splitting, esbuild writes an entry's imports of shared chunks above the
  // entry's own imports. Without this banner, instrument.js evaluates the chunk,
  // and the @wxyc/lml-client it imports (which reads the environment at module
  // load), before instrument.ts's first import, 'dotenv/config'. A banner is
  // the first statement of every output file, and ESM evaluates imports in
  // source order, so .env loads before anything else in the preload. Under the
  // preload, the same line in the chunk and in app.js is a no-op, because Node
  // evaluates a module once per process. Started without the preload (CI runs
  // `node dist/app.js`), app.js's banner is what loads .env; dotenv never
  // overrides variables that are already set (BS#2975).
  banner: { js: "import 'dotenv/config';" },
  // `sns-validator` is CJS-only; bundling it into ESM produces a `Dynamic
  // require of "sns-validator" is not supported` at runtime. Mark external
  // so Node's CJS↔ESM interop resolves it through node_modules.
  // `@wxyc/lml-client` is external on purpose, not just because it is a
  // dependency: the preload's Sentry filter checks `instanceof LmlClientError`
  // against errors thrown from app.js (BS#2949).
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
