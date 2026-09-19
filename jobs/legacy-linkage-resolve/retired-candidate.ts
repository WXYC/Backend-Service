/**
 * The "retired linkage candidate" classifier — split out of `job.ts` (BS#2594
 * review) as its own single-responsibility module. Unit-tested in
 * `tests/unit/jobs/legacy-linkage-resolve/job.test.ts` against a hand-built
 * double of the wrapped `DrizzleQueryError` shape production actually hits
 * (`retiredLinkageCandidateError`, wrapped unconditionally — nothing in this
 * job ever sees a bare driver error), exercised there through `job.ts`'s
 * normal import — this file changes WHERE the logic lives, not who calls it.
 * The bare-shape fallback is covered one level down, on
 * `extractConstraintName` itself (`tests/unit/database/sqlstate.test.ts`,
 * "falls back to a top-level constraint_name when there is no cause"), not on
 * this predicate. `shared/database/src/sqlstate.ts`'s docstring records the
 * general shape of the risk hand-built-double-only coverage carries: a
 * predicate proven only against doubles shipped as dead code against a green
 * suite once already (`deleteAlbumFromDB`'s `lock_unavailable` arm).
 * `tests/integration/legacy-linkage-retired-candidate.spec.js` NARROWS that
 * gap without closing it — not by importing this predicate, but by proving
 * the raw error shape the unit double assumes (SQLSTATE `23503`,
 * `constraint_name` one of the two below) is what a real concurrent `DELETE
 * /library/:id` actually produces. Nothing yet drives this predicate against
 * a real driver error, wrapped or bare; WXYC/Backend-Service#2605 tracks
 * that. An earlier draft built this module to a CJS bundle so that spec could
 * `require` the real predicate, but the require made the integration jest
 * project fail to LOAD — it has no TypeScript transform, and the require
 * pulled in `drizzle-orm`, which resolves to `tests/__mocks__/drizzle-orm.ts`
 * — so BS#2601 dropped it along with the CJS dual-emit that existed only to
 * produce that artifact. See that spec's own docstring.
 */

import { extractSqlState, extractConstraintName } from '@wxyc/database';

/**
 * The two FK constraints a `23503` on this job's own UPDATEs can legitimately
 * mean "the `library` row this candidate was about to link to was deleted
 * mid-statement" — a librarian's `DELETE /library/:id` racing this pass.
 * Reachable on the rotation pass unconditionally (that FK check has always
 * run); reachable on the flowsheet pass only since BS#2565 removed the
 * delete's flowsheet-references refusal, which had previously kept a
 * flowsheet-linked `library` row from ever being deletable out from under
 * this job. Names are Drizzle's own naming (`<table>_<column>_<ref-table>_<ref-
 * column>_fk`), not Postgres's default `_fkey` suffix.
 *
 * Deliberately a SIBLING set to `@wxyc/database`'s `LOCK_CONTENTION_SQLSTATES`,
 * not a widening of it: `55P03`/`40P01` mean "someone else holds the row, try
 * later" and `23503` here means "the row is gone, this candidate is retired"
 * — different claims, reported under different Sentry fingerprints in
 * `job.ts`. Folding `23503` into `LOCK_CONTENTION_SQLSTATES` would also make
 * every OTHER foreign-key bug on a lock-bounded writer silently retryable,
 * which is exactly what the job's own "does not mistake an unrelated wrapped
 * error for lock contention" test guards against — that test's `23503`
 * carries no constraint name, so it falls through this predicate and stays a
 * hard failure.
 */
export const RETIRED_LINKAGE_CONSTRAINTS = new Set([
  'flowsheet_album_id_library_id_fk',
  'rotation_album_id_library_id_fk',
]);

/**
 * True only for a `23503` against one of the two constraints above — never for
 * a `23503` on any other constraint, which stays a hard failure. Uses the
 * shared `extractSqlState`/`extractConstraintName` (`shared/database/src/
 * sqlstate.ts`) rather than re-deriving the two-level `.cause` unwrap here:
 * the constraint name lives at the same depth as the SQLSTATE, off the same
 * postgres-js driver error, so one extraction shape covers both.
 */
export const isRetiredLinkageCandidateError = (error: unknown): boolean => {
  if (extractSqlState(error) !== '23503') return false;
  const constraint = extractConstraintName(error);
  return constraint !== undefined && RETIRED_LINKAGE_CONSTRAINTS.has(constraint);
};
