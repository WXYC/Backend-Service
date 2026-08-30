import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  // `write.ts`/`match.ts`/`candidates.ts` also emit a CommonJS bundle each
  // (dist/*.cjs) so the babel-jest integration spec can `require` and
  // exercise the REAL write/match/candidate-load functions against Postgres
  // rather than reimplementing them — same arrangement as
  // `jobs/library-call-number-dedup`'s `merge.ts`.
  entry: ['job.ts', 'write.ts', 'match.ts', 'candidates.ts'],
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
