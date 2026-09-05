import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/station-passcode.ts` is a second entry, not just a barrel
  // re-export — mirrors `@wxyc/observability`'s `./metrics` subpath
  // (see that package's CLAUDE.md entry): the barrel (`src/index.ts`) also
  // pulls in `auth.definition.ts`, which imports the pure-ESM `better-auth`
  // package, so any plain-CJS consumer of the barrel (e.g. a `require()`
  // from this repo's Jest integration tier, which cannot load a pure-ESM
  // dependency) fails at import time even though it only wants
  // station-passcode.ts's exports, which have no better-auth dependency at
  // all. Not re-exported from the barrel — the barrel's own named exports
  // (index.ts) remain the public surface for real consumers (#2361-#2364);
  // this second entry exists solely so tests/integration/station-passcode.spec.js
  // can `require('../../shared/authentication/dist/station-passcode.js')`
  // directly, bypassing the barrel and its better-auth dependency.
  entry: ['src/index.ts', 'src/station-passcode.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  external: ['drizzle-orm', 'postgres', 'better-auth', '@wxyc/shared', '@sentry/node'],
});
