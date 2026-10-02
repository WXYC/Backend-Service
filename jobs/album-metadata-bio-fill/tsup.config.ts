import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM entrypoint the Docker image runs (dist/job.js).
  //
  // `cohort.ts` also emits CommonJS (dist/cohort.cjs) so the babel-jest
  // integration spec can `require` the REAL statements and run them against
  // Postgres, instead of testing a hand-copied SQL mirror. Same mechanism as
  // `jobs/station-signup-review`'s dist/query.cjs.
  entry: ['job.ts', 'cohort.ts'],
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
