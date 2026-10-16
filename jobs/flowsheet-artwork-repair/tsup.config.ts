import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `degraded-keep-sql.ts` also emits a CommonJS bundle (dist/degraded-keep-sql.cjs)
  // so the babel-jest integration spec can `require` and run the REAL builder
  // against Postgres (BS#3126/BS#3127), the recipe of
  // `jobs/artist-unicode-dedup/tsup.config.ts`. `job.ts` gets a `.cjs` too,
  // which is harmless: the Docker image only runs `dist/job.js`.
  entry: ['job.ts', 'degraded-keep-sql.ts'],
  format: ['esm', 'cjs'],
  // No shared chunk: `dist/job.js` stays one self-contained file, as before.
  splitting: false,
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,
}));
