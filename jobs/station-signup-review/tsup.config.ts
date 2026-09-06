import { defineConfig } from 'tsup';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig((options) => ({
  // `job.ts` is the ESM CLI entrypoint the Docker image runs (dist/job.js).
  //
  // `query.ts` and `downgrade.ts` ALSO emit CommonJS bundles (dist/query.cjs,
  // dist/downgrade.cjs) so the babel-jest integration spec can `require` and
  // run the REAL predicates against Postgres through `@wxyc/database`'s
  // postgres-js driver -- the same mechanism `jobs/metadata-no-match-digest`
  // uses for `dist/query.cjs` and `jobs/artist-unicode-dedup` for
  // `dist/merge.cjs`.
  //
  // This is not optional polish for this job. Every unit suite in the repo
  // mocks `drizzle-orm` wholesale, so a mocked predicate is only ever asserted
  // as the SHAPE of a mock argument -- and this is the one job in the fleet
  // that changes a DJ's privileges. `tests/integration/station-signup-review.spec.js`
  // is what pins that the downgrade actually flips `auth_member.role`, leaves
  // `auth_user.role` alone, stamps `self_signup_downgraded_at`, and is a
  // genuine no-op on a second run -- the re-fire loop that shipped green
  // against mocks.
  entry: ['job.ts', 'query.ts', 'downgrade.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  onSuccess: options.watch ? 'node ./dist/job.js' : undefined,
  minify: !options.watch,

  esbuildOptions(options) {
    options.alias = {
      '@': resolve(__dirname),
    };
  },
}));
