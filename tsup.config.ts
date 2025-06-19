import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/app.ts'],
  outDir: 'dist',
  format: ['esm'], // Use ESM instead of CommonJS
  clean: true,
  sourcemap: true,

  loader: {
    '.yaml': 'text',
  },

  // Environment variables
  env: {
    NODE_ENV: process.env.NODE_ENV || 'development',
  },
});
