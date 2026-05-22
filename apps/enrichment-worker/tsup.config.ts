import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['worker.ts', 'instrument.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['@wxyc/database', 'drizzle-orm', 'postgres', '@sentry/node', '@wxyc/lml-client'],
  onSuccess: options.watch ? 'node --import ./dist/instrument.js ./dist/worker.js' : undefined,
}));
