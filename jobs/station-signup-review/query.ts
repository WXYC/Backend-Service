/**
 * The pending-review query: every `auth_user` row that self-signed up and
 * has not yet been reviewed by a manager.
 *
 * Pending = `self_signup_at IS NOT NULL AND self_signup_reviewed_at IS
 * NULL` -- see `shared/database/src/schema.ts`'s comment on those columns
 * for why there is deliberately no separate `pending_review` boolean.
 *
 * **`self_signup_downgraded_at` is selected but deliberately NOT filtered
 * on here.** It is the downgrade actuator's terminal marker (BS#2364), and
 * only `downgrade.ts` narrows by it. This cohort is the *digest's* cohort,
 * and it is the same cohort dj-site's roster review queue shows, so an
 * account the job already downgraded must keep appearing every day until a
 * manager actually reviews it. Adding the marker to this WHERE clause would
 * make a downgraded account vanish from the digest the morning after it was
 * downgraded -- silently, and exactly when a human most needs to see it.
 *
 * Uses the Drizzle query builder (not raw `db.execute`), unlike
 * `jobs/metadata-no-match-digest/query.ts` -- that job's epoch-extraction
 * workaround exists only for `db.execute(sql\`...\`)`, which bypasses
 * Drizzle's own column-type mapping. The query builder used here maps
 * `timestamp` columns to real `Date`s via each column's own
 * `mapFromDriverValue`, so no epoch dance is needed.
 */
import { and, isNotNull, isNull } from 'drizzle-orm';
import { db, user } from '@wxyc/database';

export interface PendingSignupRow {
  userId: string;
  name: string;
  email: string;
  djName: string | null;
  /** NOT NULL by construction of the WHERE clause below. */
  selfSignupAt: Date;
  /**
   * When `jobs/station-signup-review`'s downgrade actuator last flipped this
   * account `dj` -> `member`, or `null` if it never has. Read-only here; the
   * actuator's own predicate lives in `downgrade.ts`.
   */
  selfSignupDowngradedAt: Date | null;
}

/**
 * The row shape the query builder returns before the `selfSignupAt`
 * non-null assertion below -- `isNotNull()` proves it at the SQL level but
 * Drizzle's column type stays nullable at the TS level.
 */
interface RawPendingSignupRow {
  userId: string;
  name: string;
  email: string;
  djName: string | null;
  selfSignupAt: Date | null;
  selfSignupDowngradedAt: Date | null;
}

export const queryPendingSelfSignups = async (): Promise<PendingSignupRow[]> => {
  const rows: RawPendingSignupRow[] = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      djName: user.djName,
      selfSignupAt: user.selfSignupAt,
      selfSignupDowngradedAt: user.selfSignupDowngradedAt,
    })
    .from(user)
    .where(and(isNotNull(user.selfSignupAt), isNull(user.selfSignupReviewedAt)));

  return rows
    .filter((row): row is RawPendingSignupRow & { selfSignupAt: Date } => row.selfSignupAt !== null)
    .map((row) => ({ ...row, selfSignupAt: row.selfSignupAt }));
};
