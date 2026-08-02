import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // `streaming-merge-sql.ts` also emits a CommonJS bundle (dist/streaming-
  // merge-sql.cjs) so the babel-jest integration spec
  // (tests/integration/enrichment-worker-streaming-toctou.spec.js) can
  // `require` and exercise the REAL `buildStreamingFieldConflictSet` against
  // Postgres without reimplementing it (BS#1945) — same recipe as
  // `jobs/artist-unicode-dedup/tsup.config.ts`'s `merge.ts`. `worker.ts`/
  // `instrument.ts` pick up the extra `.cjs` output too (harmless — the
  // Docker image only ever runs `dist/worker.js`), rather than splitting
  // this into a second config object for one entry.
  entry: ['worker.ts', 'instrument.ts', 'streaming-merge-sql.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['@wxyc/database', 'drizzle-orm', 'postgres', '@sentry/node', '@wxyc/lml-client'],
  onSuccess: options.watch ? 'node --import ./dist/instrument.js ./dist/worker.js' : undefined,
}));
