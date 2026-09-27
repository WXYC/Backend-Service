/**
 * Pure re-export. The implementation moved to
 * `shared/database/src/streaming-merge-sql.ts` (BS#2693) so that
 * `jobs/album-level-backfill` and `jobs/flowsheet-artwork-repair` can share
 * `buildStreamingFieldConflictSet`'s status CASE instead of each hand-rolling a
 * fourth copy of `mergeStreamingField`'s rules in SQL. See that file's header
 * for the rule-by-rule argument, and for why the subpath — not the
 * `@wxyc/database` barrel — is the route.
 *
 * This file stays because three things address the module by THIS path and none
 * of them should have to change for a move:
 *
 *   1. `enrich.ts` imports `./streaming-merge-sql.js` and re-exports
 *      `buildStreamingFieldConflictSet`, which is how
 *      `tests/unit/apps/enrichment-worker/enrich.test.ts` reaches it;
 *   2. `tsup.config.ts` lists this file as an entry, so the workspace build
 *      still emits `dist/streaming-merge-sql.cjs`;
 *   3. `tests/integration/enrichment-worker-streaming-toctou.spec.js` `require`s
 *      that exact compiled path to exercise the real builder against a live
 *      Postgres.
 *
 * Nothing is redefined here — a second definition is the drift BS#1945 removed.
 */

import type { StreamingResolutionStatus as LmlStatus } from '@wxyc/lml-client';
import type { StreamingResolutionStatus as DbStatus } from '@wxyc/database/streaming-merge-sql';

export {
  buildStreamingFieldConflictSet,
  fillOrUpgradeSearchUrl,
  NO_FALLBACK,
} from '@wxyc/database/streaming-merge-sql';

/**
 * Drift guard for the status union `shared/database` restates locally (it
 * imports no `@wxyc/*` package — see that file's header).
 *
 * This assertion lives HERE, in the shim, because `apps/**` is inside
 * `npm run typecheck` while `tests/**` is not: `tests/tsconfig.json` sets
 * `isolatedModules: true`, which makes ts-jest transpile-only, so the same two
 * lines in a test file would pass no matter what the unions said. Measured, not
 * assumed — removing a `paths` entry the tests import through produced no
 * diagnostic at all.
 *
 * If `@wxyc/shared` gains or loses a verdict, one of the two `true`s below stops
 * being assignable and `npm run typecheck` fails, which is the moment to update
 * `shared/database/src/streaming-merge-sql.ts` rather than discover a branch of
 * `buildStreamingFieldConflictSet` has quietly become unreachable.
 */
type Covers<A, B> = [A] extends [B] ? true : false;
const _dbCoversLml: Covers<LmlStatus, DbStatus> = true;
const _lmlCoversDb: Covers<DbStatus, LmlStatus> = true;
void _dbCoversLml;
void _lmlCoversDb;
