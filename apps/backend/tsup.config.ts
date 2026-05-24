import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the directory where this config file is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `instrument.ts` is a separate entry so it can be loaded via
  // `node --import ./dist/instrument.js dist/app.js`. Under ESM, all top-level
  // imports in `app.ts` are hoisted before its body runs, so a static
  // `import './instrument.js'` would resolve `express` before `Sentry.init`
  // could install its monkey-patches. `--import` runs the file before any
  // other module graph entry is evaluated.
  entry: ['app.ts', 'instrument.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // `sns-validator` is CJS-only; bundling it into ESM produces a `Dynamic
  // require of "sns-validator" is not supported` at runtime. Mark external
  // so Node's CJS↔ESM interop resolves it through node_modules.
  external: ['@sentry/node', 'ws', 'sns-validator'],
  onSuccess: options.watch ? 'node --import ./dist/instrument.js ./dist/app.js' : undefined,
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
