import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// PR1 of the BS#1209 split: only the writers ship in this PR. The entry
// is `repair.ts` so the workspace builds standalone (no `job.ts` yet).
// The follow-up PR adds `job.ts` (entrypoint) + `orchestrate.ts` and
// re-points this config back to `job.ts`.
export default defineConfig(() => ({
  entry: ['repair.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  minify: true,

  esbuildOptions(options) {
    options.alias = {
      '@': resolve(__dirname),
    };
  },
}));
