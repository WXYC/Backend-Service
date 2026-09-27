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
  // With two entries, esbuild's ESM code splitting (tsup's default) hoists shared
  // helpers into a content-hashed `dist/chunk-*.mjs` whose name changes per build,
  // and makes `dist/streaming-merge-sql.mjs` import it. Nothing misbehaves — the
  // chunk holds only esbuild's `__export` helper and every Dockerfile copies the
  // whole `dist` — but the subpath's entire justification is that it is reachable
  // with NO barrel code in the graph, and that claim should hold of the artifact and
  // not merely of the source. `false` keeps each entry genuinely standalone and the
  // dist file set stable, matching `apps/enrichment-worker/tsup.config.ts`.
  splitting: false,
  external: ['drizzle-orm', 'postgres'],
});
