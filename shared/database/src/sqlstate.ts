/**
 * SQLSTATE decoding for a caught database error, and the lock-contention
 * vocabulary built on it.
 *
 * **The SQLSTATE is NOT at the top level of what a drizzle query throws.**
 * drizzle-orm (0.45.x) wraps every query rejection in a `DrizzleQueryError`
 * whose own `message` is the generic `Failed query: …`, whose own `code` is
 * `undefined`, and whose `.cause` is the driver error — for postgres-js a
 * `PostgresError` carrying the 5-char SQLSTATE on `.code`, parsed straight off
 * the wire `ErrorResponse`'s `C` field. The wrap is unconditional
 * (`drizzle-orm/errors.js`, applied in `pg-core/session.js`'s
 * `queryWithCache`), so a classifier that reads only `error.code` sees
 * `undefined` for every real SQLSTATE.
 *
 * That failure mode survives review because it is invisible to tests: a unit
 * test throwing a hand-built `{ code }` cannot reproduce the wrapper, so it
 * stays green while production classifies nothing. It has happened here —
 * `deleteAlbumFromDB`'s `lock_unavailable` (503) arm in
 * `apps/backend/services/library.service.ts` was dead code against a passing
 * suite. Any new test double for a database rejection should therefore build
 * the WRAPPED shape by default and treat the bare one as the opt-out.
 *
 * The decode prefers `cause.code` and falls back to a top-level `.code`. The
 * fallback is what keeps a bare driver error — and the doubles that model one
 * — classifying the same way as the wrapped production form.
 */

/**
 * Read the Postgres SQLSTATE (or postgres-js / Node driver error code) out of
 * a caught error, robust to drizzle's `DrizzleQueryError` wrapper.
 *
 * Returns `undefined` when no *string* code can be read — from a plain
 * `Error`, a thrown string, `null`, or a numeric `code`. Callers treat that as
 * "unknown" and are expected to fail safe from there (retry rather than
 * dead-letter; a generic 500 rather than a bespoke status).
 */
export const extractSqlState = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const code = causeCode ?? (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Postgres SQLSTATEs a lock-bounded writer converts into a clean stand-down
 * rather than a failed run.
 *
 * Deliberately does NOT include `57014` (`query_canceled`, which is what a
 * `statement_timeout` raises). If a `SET LOCAL lock_timeout` guard ever fails
 * to bind — issued outside an explicit transaction it is silently
 * connection-scoped-and-discarded under the postgres-js driver — `57014` is
 * the error that comes back, and it must stay a hard failure rather than be
 * reported as a deliberate skip.
 */
export const LOCK_CONTENTION_SQLSTATES: ReadonlySet<string> = new Set([
  '55P03', // lock_not_available — our own lock_timeout fired
  '40P01', // deadlock_detected — we were chosen as the victim
]);

/** True when `error` is a lock-contention rejection, in either the wrapped or the bare shape. */
export const isLockContentionError = (error: unknown): boolean => {
  const code = extractSqlState(error);
  return code !== undefined && LOCK_CONTENTION_SQLSTATES.has(code);
};

/**
 * `SET LOCAL lock_timeout` for a writer that must be the side which yields.
 *
 * **Why below 1 s.** Deliberately under Postgres's default 1 s
 * `deadlock_timeout`. Standing down before the deadlock detector even runs
 * makes this side always the one that gives up, so it can never be the reason
 * the other side's transaction is aborted as the chosen victim — which matters
 * because the other side is invariably the one that must not lose: a live DJ's
 * play insert, or `jobs/library-etl`'s quarter-hour import transaction.
 *
 * 750 ms is also ~2 orders of magnitude above a live UI write's hold on the
 * same rows (`POST`/`PATCH /library` commit in milliseconds), so routine
 * librarian traffic does not trip it.
 *
 * This value was independently chosen twice, for exactly this reason, before
 * it was named once: `DELETE_ALBUM_LOCK_TIMEOUT_MS` in
 * `apps/backend/services/library.service.ts` and `LINKAGE_LOCK_TIMEOUT_MS` in
 * `jobs/legacy-linkage-resolve/job.ts`. Both keep their local names — each
 * docstring carries the lock-order argument specific to its own transaction —
 * but the number belongs here, so a future adjustment cannot move one and
 * leave the other behind.
 */
export const SUB_DEADLOCK_LOCK_TIMEOUT_MS = 750;
