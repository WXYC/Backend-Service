import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  // `retired-candidate.ts` ALSO emits a CommonJS bundle (dist/retired-
  // candidate.cjs) so the babel-jest integration spec can `require` and run
  // the REAL `isRetiredLinkageCandidateError` against a REAL postgres-js
  // driver error, rather than a second hand-built copy of the SQLSTATE-plus-
  // constraint-name check (BS#2594 review) — same mechanism
  // `jobs/station-signup-review` uses for `dist/query.cjs`/`dist/
  // downgrade.cjs` and `jobs/metadata-no-match-digest` for `dist/query.cjs`.
  entry: ['job.ts', 'retired-candidate.ts'],
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
