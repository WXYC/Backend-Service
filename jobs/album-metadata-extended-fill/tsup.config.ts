import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `job.ts` is the ESM entrypoint the Docker image runs (dist/job.js).
  //
  // `cohort.ts` also emits CommonJS (dist/cohort.cjs) so the babel-jest
  // integration spec can `require` the REAL statements and run them against
  // Postgres, instead of testing a hand-copied SQL mirror. Same mechanism as
  // `jobs/album-metadata-bio-fill`'s dist/cohort.cjs.
  // `fill.ts` likewise, so the write spec runs the real UPDATE and outcome classification.
  entry: ['job.ts', 'cohort.ts', 'fill.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,
}));
