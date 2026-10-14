import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM entrypoint the Docker image runs (dist/job.js).
  //
  // Each later slice of BS#3137 adds the entry for the module it creates and
  // its integration spec `require`s as CommonJS (dist/<module>.cjs), as the
  // bio fill lists `['job.ts', 'cohort.ts']`. Only `job.ts` exists yet, and
  // CI builds every workspace, so an entry for a missing file would break it.
  entry: ['job.ts'],
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
