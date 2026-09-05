/**
 * The 30-day auto-downgrade write path (BS#2364 / station-signup-review
 * plan). Self-signed accounts left unreviewed for more than
 * `DOWNGRADE_AFTER_DAYS` drop `dj` -> `member`.
 *
 * Writes `auth_member.role` directly via `@wxyc/database`, exactly as the
 * issue specifies. This is safe for this ONE role pair because
 * `grantsAdminFlag` (`shared/authentication/src/admin-flag-sync.ts`) is
 * `normalizeRole(role) === 'stationManager'` -- neither `dj` nor `member`
 * ever touches the `auth_user.role='admin'` flag, so no better-auth hook
 * needs to fire for this write to be complete. Reusing this bare-write
 * pattern for a different role pair (anything touching stationManager)
 * would desync the admin flag silently -- see WXYC/Backend-Service#2171 for
 * the standing `auth_user.role` / `auth_member.role` drift this relies on
 * not making worse.
 *
 * Never deletes, never bans, never writes `auth_user` at all -- reversible
 * with one roster edit back to `dj`.
 */
import { and, eq } from 'drizzle-orm';
import { db, member } from '@wxyc/database';
import type { PendingSignupRow } from './query.js';

/**
 * Why 30 days: it exceeds any holiday break, so the downgrade cannot fire
 * mid-break and strand a working DJ. It only ever catches accounts nobody
 * reviewed *after* the break ended.
 */
export const DOWNGRADE_AFTER_DAYS = 30;

const DOWNGRADE_AFTER_MS = DOWNGRADE_AFTER_DAYS * 24 * 60 * 60 * 1000;

/** `true` once `now` is at or past `selfSignupAt + DOWNGRADE_AFTER_DAYS` (inclusive of the boundary instant). */
export const isPastDowngradeCutoff = (selfSignupAt: Date, now: Date): boolean =>
  now.getTime() - selfSignupAt.getTime() >= DOWNGRADE_AFTER_MS;

type DbClient = typeof db;

/**
 * Downgrade every overdue account's `auth_member.role` from `'dj'` to
 * `'member'`. `rows` is expected to already be filtered to accounts pending
 * review (`self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL`)
 * by `query.ts` -- this function does not re-check review state, only the
 * 30-day boundary and the current role.
 *
 * The `WHERE role = 'dj'` guard (not just `WHERE user_id = :id`) makes the
 * write a no-op for an account already downgraded by a prior run, or one a
 * manager already promoted/reviewed out of `dj` some other way -- `returning()`
 * reports whether a row actually matched, which is what determines whether
 * the account is reported as downgraded in the digest.
 *
 * One UPDATE per account rather than a single batched `IN (...)` -- the
 * pending cohort is small (self-signup is a rare event, not a bulk import),
 * so the simplicity of an independent per-row result outweighs the
 * batching this table's normal write volume would otherwise call for.
 */
export const downgradeOverdueAccounts = async (
  dbClient: DbClient,
  rows: PendingSignupRow[],
  now: Date
): Promise<PendingSignupRow[]> => {
  const overdue = rows.filter((row) => isPastDowngradeCutoff(row.selfSignupAt, now));
  const downgraded: PendingSignupRow[] = [];

  for (const row of overdue) {
    const result = await dbClient
      .update(member)
      .set({ role: 'member' })
      .where(and(eq(member.userId, row.userId), eq(member.role, 'dj')))
      .returning({ id: member.id });
    if (result.length > 0) downgraded.push(row);
  }

  return downgraded;
};
