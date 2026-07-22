import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  external: ['@sentry/node', '@wxyc/database', 'drizzle-orm'],
});
