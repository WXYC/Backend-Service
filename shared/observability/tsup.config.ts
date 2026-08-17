import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/metrics.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  external: ['@sentry/core', '@sentry/node', '@aws-sdk/client-cloudwatch'],
});
