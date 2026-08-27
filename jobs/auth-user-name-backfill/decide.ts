/**
 * Pure decisions for the auth_user.name backfill (DJ real-name PII
 * safeguards plan, Track 2d).
 *
 * Split out from job.ts so both decisions — the per-row rewrite and the
 * machine-enforced precondition gate — are unit-testable without a database.
 */

import { resolveDjDisplayName } from '@wxyc/database';

export interface AuthUserBackfillRow {
  id: string;
  name: string;
  username: string | null;
  djName: string | null;
  realName: string | null;
  isAnonymous: boolean;
}

/**
 * The 2a preserve-first predicate, mirrored here as the gate this job runs
 * against every row before it writes anything:
 *
 *   (real_name IS NULL OR trim(real_name) = '')
 *     AND NOT is_anonymous
 *     AND name NOT IN ('Anonymous', 'Auto DJ')
 *     AND name IS DISTINCT FROM username
 *     AND trim(name) IS DISTINCT FROM trim(dj_name)
 *
 * ('Anonymous'-literal handles need no special-case in that last clause:
 * a row whose `dj_name` is the literal 'Anonymous' can only collide with
 * `name = 'Anonymous'`, which the `name NOT IN (...)` clause already
 * excludes on its own. The TS predicate below applies the fuller
 * `resolveDjDisplayName` semantics — case-insensitive, treats blank/
 * 'Anonymous' as no handle — for the same reason `dj-name.ts`'s module doc
 * warns against re-deriving that chain in SQL; this comment documents the
 * simpler literal-trim SQL shape a manual audit query would use, not what
 * the function below executes.)
 *
 * A row matching this predicate holds its ONLY copy of a legal name in
 * `auth_user.name` — 2a (the reviewed manual SQL that copies `name ->
 * real_name` for exactly these rows) has not run against this database.
 * Rewriting `name` here before that copy exists would lose the legal name
 * outright: "the one unrecoverable failure in this plan." The gate makes
 * run order irrelevant — it aborts regardless of whether 2a already ran.
 *
 * SQL's `IS DISTINCT FROM` is null-safe inequality; plain `!==` on two
 * `string | null` values reproduces it exactly in JS (`null !== null` is
 * `false`, matching `NULL IS DISTINCT FROM NULL` = false; `null !== 'x'` is
 * `true`, matching the SQL).
 *
 * HANDLE EXEMPTION (BS#2297 review finding 2): a user provisioned after
 * this PR's `databaseHooks.user.create.before` hook deploys can legitimately
 * end up with `name = <handle>`, `real_name` blank, and `name` distinct from
 * `username` (no username chosen yet, or a username that differs from the
 * handle) — that shape used to false-positive this gate forever, and the
 * gate's remediation message ("run 2a first") would have had an operator
 * copy a HANDLE into the real_name PII column. A row whose trimmed `name`
 * equals its resolved handle holds no legal name in `name` at all — there is
 * nothing to preserve — so it's exempted alongside the existing
 * `name === username` exemption. This is the same "handle-is-real-name"
 * exemption the stored-data scrub carries: a DJ whose real name coincides
 * with their handle is exempted too, and correctly so — there's no
 * information loss in skipping it (see decide.test.ts's exemption-matrix
 * comment for the full reasoning).
 */
export function violatesPreserveFirstPrecondition(
  row: Pick<AuthUserBackfillRow, 'realName' | 'isAnonymous' | 'name' | 'username' | 'djName'>
): boolean {
  const realNameBlank = row.realName === null || row.realName.trim() === '';
  const handle = resolveDjDisplayName(row.djName ?? null);
  const nameIsHandle = handle !== null && row.name.trim() === handle;
  return (
    realNameBlank &&
    !row.isAnonymous &&
    row.name !== 'Anonymous' &&
    row.name !== 'Auto DJ' &&
    row.name !== row.username &&
    !nameIsHandle
  );
}

/**
 * Decide the backfilled `name` for one auth_user row.
 *
 * `name := resolveDjDisplayName(dj_name) ?? username`, computed in
 * TypeScript via the canonical helper — never re-derived in SQL, the exact
 * mistake `dj-name.ts`'s module doc warns against.
 *
 * Returns `undefined` (leave the row unchanged) when:
 *   - the user is anonymous (per-device throwaways, not station members —
 *     `databaseHooks.user.create.after` never adds them to the roster
 *     either);
 *   - `name` is already the literal `'Auto DJ'` service-account marker
 *     (`create-auto-dj-user.ts`) — checked explicitly rather than relying on
 *     the derived value happening to equal it;
 *   - neither a usable handle nor a `username` exists — nothing to backfill
 *     to, so the row is left exactly as the live read path already
 *     tolerates it;
 *   - the derived value already equals the stored `name` — a no-op write is
 *     avoided rather than executed.
 */
export function decideAuthUserNameBackfill(
  row: Pick<AuthUserBackfillRow, 'name' | 'username' | 'djName' | 'isAnonymous'>
): string | undefined {
  if (row.isAnonymous) return undefined;
  if (row.name === 'Auto DJ') return undefined;
  const derived = resolveDjDisplayName(row.djName ?? null) ?? row.username ?? undefined;
  if (derived === undefined) return undefined;
  if (derived === row.name) return undefined;
  return derived;
}
