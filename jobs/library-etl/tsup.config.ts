import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the directory where this config file is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  entry: ['job.ts'],
  format: ['cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,

  esbuildOptions(options) {
    // Resolve @/ alias to the directory where this config file is located
    // This matches TypeScript's behavior (relative to tsconfig.json location)
    options.alias = {
      '@': resolve(__dirname),
    };
  },
}));
