import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/streaming-merge-sql.ts` is a SEPARATE entry, not just a barrel
  // re-export: the barrel pulls in `client.ts`, which throws at import time on
  // missing DB env vars, and the whole point of that module is to be importable
  // without starting a pool (BS#1945, BS#2693). Same recipe as
  // `shared/observability`'s `./metrics`.
  entry: ['src/index.ts', 'src/streaming-merge-sql.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  external: ['drizzle-orm', 'postgres'],
});
