import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['app.ts'],
  format: ["esm"],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/app.js' : undefined,
  minify: !options.watch,

  loader: {
    '.yaml': 'text',
  }
}));
