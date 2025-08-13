import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/app.ts',
    'src/services/**/*.ts',
    'src/controllers/**/*.ts',
    'src/routes/**/*.ts',
    'src/middleware/**/*.ts',
    'src/config/**/*.ts'
  ],
  outDir: 'dist',
  format: ['cjs'], // Use CommonJS for Jest compatibility
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
