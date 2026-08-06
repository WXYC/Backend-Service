import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  // `orchestrate.ts` also emits a CommonJS bundle (dist/orchestrate.cjs) so the
  // babel-jest integration spec can `require` and exercise the REAL
  // `invalidateAlbumBatch` against Postgres without reimplementing its SQL —
  // the same arrangement `jobs/artist-unicode-dedup` uses for `dist/merge.cjs`
  // (BS#1897 review MED-1). A hand-mirrored copy of the statement in the spec
  // would pass even with the shipped defect restored.
  entry: ['job.ts', 'orchestrate.ts'],
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
