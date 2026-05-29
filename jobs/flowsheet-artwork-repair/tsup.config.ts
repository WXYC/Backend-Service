import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
