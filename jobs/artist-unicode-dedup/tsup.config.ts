import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  // `merge.ts` also emits a CommonJS bundle (dist/merge.cjs) so the babel-jest
  // integration spec can `require` and exercise the REAL merge functions
  // against Postgres without reimplementing them (BS#1897 review MED-1).
  entry: ['job.ts', 'merge.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,
}));
