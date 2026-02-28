import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['app.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  external: ['@wxyc/database', 'better-auth', 'drizzle-orm', 'express', 'cors', 'postgres'],
  onSuccess: options.watch ? 'node ./dist/app.js' : undefined,
}));
