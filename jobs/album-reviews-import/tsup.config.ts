import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint (dist/job.js). `import.ts` also emits a CommonJS bundle (dist/import.cjs) so the
  // babel-jest integration spec can `require` the REAL import and run it against Postgres.
  entry: ['job.ts', 'import.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  minify: !options.watch,
}));
