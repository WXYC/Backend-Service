import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint (dist/job.js). `backfill.ts` also emits a CommonJS bundle (dist/backfill.cjs)
  // so the babel-jest integration spec can `require` the REAL gate and write against Postgres. It imports nothing at
  // runtime, so that bundle pulls in no drizzle-orm and needs no unmock.
  entry: ['job.ts', 'backfill.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  minify: !options.watch,
}));
