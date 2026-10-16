import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  // `query.ts` also emits a CommonJS bundle (dist/query.cjs) so the babel-jest
  // integration spec can `require` and run the REAL `queryNoMatchRows` against
  // Postgres through `@wxyc/database`'s postgres-js driver -- the only way to
  // cover the date-serializer/parser passthrough the bare-postgres-js mirror
  // could never reach (mirrors jobs/artist-unicode-dedup's dist/merge.cjs).
  entry: ['job.ts', 'query.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,
}));
