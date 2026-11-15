import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `job.ts` is the ESM entrypoint the Docker image runs (dist/job.js).
  //
  // `writer.ts` also emits CommonJS (dist/writer.cjs) so the babel-jest
  // integration spec can `require` the REAL upsert and run it against Postgres
  // (BS#3809). Same mechanism as `jobs/album-metadata-extended-fill`.
  entry: ['job.ts', 'writer.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,
}));
