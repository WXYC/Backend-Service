import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  // `split.ts` also emits a CommonJS bundle (dist/split.cjs) so the babel-jest
  // integration spec can `require` and exercise the REAL split functions
  // against Postgres without reimplementing them (the artist-unicode-dedup
  // MED-1 arrangement, inherited).
  entry: ['job.ts', 'split.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,

  esbuildOptions(options) {
    options.alias = {
      '@': resolve(__dirname),
    };
  },
}));
