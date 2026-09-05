/**
 * The pending-review query: every `auth_user` row that self-signed up and
 * has not yet been reviewed by a manager.
 *
 * Pending = `self_signup_at IS NOT NULL AND self_signup_reviewed_at IS
 * NULL` -- see `shared/database/src/schema.ts`'s comment on those columns
 * for why there is deliberately no separate `pending_review` boolean.
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
}

export const queryPendingSelfSignups = async (): Promise<PendingSignupRow[]> => {
  const rows: RawPendingSignupRow[] = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      djName: user.djName,
      selfSignupAt: user.selfSignupAt,
    })
    .from(user)
    .where(and(isNotNull(user.selfSignupAt), isNull(user.selfSignupReviewedAt)));

  return rows
    .filter((row): row is RawPendingSignupRow & { selfSignupAt: Date } => row.selfSignupAt !== null)
    .map((row) => ({ ...row, selfSignupAt: row.selfSignupAt }));
};
