import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the entrypoint the image runs (dist/job.js). Each later
  // module of BS#3137 is its own entry so the babel-jest integration spec can
  // `require` the REAL statements as dist/<module>.cjs (the bio fill's
  // dist/cohort.cjs mechanism).
  entry: ['job.ts', 'cohort.ts', 'write.ts', 'artist-keep-sql.ts', 'catalog-pass.ts', 'restore.ts'],
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
