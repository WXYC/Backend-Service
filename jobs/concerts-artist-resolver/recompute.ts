/**
 * Thin re-export shim — `recomputeHasResolvedSupport` moved to
 * `@wxyc/database` (BS#1763) so `jobs/concerts-artist-lml-resolver`'s LML
 * `supportTarget` can call the SAME windowed recompute after resolving a
 * discogs-only support, without reaching into this job's internals across
 * the npm-workspace boundary. See `shared/database/src/concerts-recompute.ts`
 * for the implementation and full rationale.
 *
 * This path is preserved deliberately (mirrors the `@wxyc/legacy-mirror`
 * BS#1707 extraction, whose `http.mirror.ts` / `rotation-match.mirror.ts`
 * stayed thin shims): `job.ts` still imports from `./recompute.js`, so a
 * single import site doesn't need touching. The SQL-contract + outcome-
 * counting tests moved with the implementation to
 * `tests/unit/database/concerts-recompute.test.ts`. New code should import
 * from `@wxyc/database` directly.
 */
export { recomputeHasResolvedSupport, type RecomputeOutcome } from '@wxyc/database';
