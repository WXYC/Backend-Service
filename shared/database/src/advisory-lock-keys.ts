/**
 * Registry of every single-`bigint` Postgres advisory-lock key in this codebase. Allocate a new key HERE, and
 * nowhere else.
 *
 * `pg_advisory_xact_lock(k)` and `pg_try_advisory_lock(k)` differ in scope, not in lock space: both contend on the same
 * `k`, database-wide, across unrelated code paths and processes. Reusing a number makes one caller block behind the
 * other until it aborts at `statement_timeout` / `lock_timeout`. `advisory-lock-keys.test.ts` fails on a duplicate value.
 *
 * Scope matters when choosing a variant. `pg_advisory_xact_lock` releases on commit/rollback. `pg_try_advisory_lock` is
 * session-scoped and can be silently dropped when postgres-js recycles an idle connection (see the hazard recorded in
 * `client.ts`), so a session-scoped holder needs a dedicated client with `maxLifetimeSeconds: 0`.
 *
 * Values are allocation dates (YYYYMMDD), so a nearby date is the likeliest accidental collision. Never renumber a live
 * key: during a rolling deploy an old and a new process would take different locks and run concurrently.
 *
 * Not in this map: the hashed key in `apps/backend/services/library.service.ts`,
 * `pg_advisory_xact_lock(hashtextextended('artist-code-bucket:' || genre || ':' || letters, 0))`, which derives its
 * bigint from the destination shelf. It shares the lock space, so a literal here that happened to equal one of those
 * hashes would collide, though a 64-bit hash makes that vanishingly unlikely.
 *
 * Keep this module free of runtime imports so the unit-test mock can re-export it directly.
 */
export const ADVISORY_LOCK_KEYS = {
  /** `PUT` of the Slack ban-moderators roster, `apps/backend/routes/internal-slack-moderators.route.ts`. */
  slackBanModerators: 20260808,
  /** Station passcode rotation, `shared/authentication/src/station-passcode.ts`. */
  stationPasscodeRotate: 20260905,
  /** Catalog restore's next-free-code read-then-insert, `apps/backend/services/library.service.ts`. */
  restoreBatch: 20260919,
} as const;

/**
 * Keys that were once live and must never be reallocated. A stale deployed process could still be holding one.
 */
export const RETIRED_ADVISORY_LOCK_KEYS = {
  /** `jobs/legacy-mirror-reconcile`, removed in BS#2403. */
  legacyMirrorReconcile: 17071707,
} as const;
