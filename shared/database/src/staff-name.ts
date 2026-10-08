/**
 * The name a staff-only surface shows for an account (BS#3051): the legal name when the account has one, else
 * `auth_user.name` (on-air handle, else username).
 *
 * This is the one file besides provisioning that reads `auth_user.real_name` (the `wxyc/restricted-real-name` allow-list names it, and
 * docs/pii.md explains why). Every other file reaches the column through here, so a public surface cannot pick it up by
 * accident: `readStaffName` stamps `reviews.author`, `review_revisions.edited_by`, `fcc_notes.reported_by` and
 * `fcc_notes.confirmed_by`, all read only by role-gated `reviews:*` routes. Nothing here is for a public read, and
 * deliberately dependency-light like `dj-name.ts`, which stays off the allow-list.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import type { db } from './client.js';
import { user } from './schema.js';

/** The stamp columns are `varchar(128)` while `auth_user.name` is 255, so a long name is cut to its first 128 code points (Postgres counts characters, not UTF-16 units). */
export const AUTHOR_MAX = 128;
export const snapshotAuthor = (name: string | null | undefined) =>
  name == null ? null : [...name].slice(0, AUTHOR_MAX).join('');

/**
 * SQL for a staff name, for a join or an aggregate: the real name unless it is null, empty or only spaces, else `name`. `account`
 * is `auth_user` or an alias of it, so the columns are qualified the way the query names the table.
 */
export const staffNameSql = (account: Pick<typeof user, 'realName' | 'name'>): SQL<string> =>
  sql<string>`coalesce(nullif(btrim(${account.realName}), ''), ${account.name})`;

/**
 * The account's staff name, cut by `snapshotAuthor`. Runs one select on the handle it is given, so a caller inside a transaction passes `tx`.
 * `null` when the account is gone or has no name.
 */
export const readStaffName = async (handle: Pick<typeof db, 'select'>, userId: string): Promise<string | null> => {
  const [row] = await handle
    .select({ name: staffNameSql(user) })
    .from(user)
    .where(eq(user.id, userId));
  return snapshotAuthor(row?.name);
};
