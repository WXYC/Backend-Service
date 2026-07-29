import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['job.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,
}));
