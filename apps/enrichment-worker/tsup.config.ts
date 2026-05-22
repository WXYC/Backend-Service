import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['worker.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['@wxyc/database', 'drizzle-orm', 'postgres'],
  onSuccess: options.watch ? 'node ./dist/worker.js' : undefined,
}));
