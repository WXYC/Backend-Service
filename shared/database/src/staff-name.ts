/**
 * The name a staff-only surface shows for an account (BS#3051): the legal name when the account has one, else
 * `auth_user.name` (on-air handle, else username).
 *
 * This is the one file besides provisioning that reads `auth_user.real_name` (the `wxyc/restricted-real-name` allow-list names it, and
 * docs/pii.md explains why). Every other file reaches the column through here, and the same rule flags an import or member access of
 * `readStaffName`/`staffNameSql` outside the four staff-surface services (`STAFF_NAME_CALLERS`), so a public surface cannot pick it up by
 * accident (the barrel's `export *` is the one shape the rule does not see): `readStaffName` stamps `reviews.author`, `review_revisions.edited_by`, `fcc_notes.reported_by` and
 * `fcc_notes.confirmed_by`, all read only by role-gated `reviews:*` routes; `staffNameSql` names the requester, holder and passer on `/intake` (BS#3052) the reviewer list on `GET /reviews/reviewers` (BS#3058) and the holder in the review notices (the passing DJ in the notices is named by `readStaffName`). Nothing here is for a public read, and
 * deliberately dependency-light like `dj-name.ts`, which stays off the allow-list.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { db } from './client.js';
import { user } from './schema.js';

/** The stamp columns are `varchar(128)` while `auth_user.name` is 255, so a long name is cut to its first 128 code points (Postgres counts characters, not UTF-16 units). */
export const AUTHOR_MAX = 128;
export const snapshotAuthor = (name: string | null | undefined) =>
  name == null ? null : [...name].slice(0, AUTHOR_MAX).join('');

/**
 * SQL for a staff name, for a join or an aggregate: the real name unless it is null, empty or only whitespace, else `name`. `account`
 * is `auth_user` or an alias of it, so the columns are qualified the way the query names the table. Postgres `btrim(text)` strips
 * only the space character, so the strip set is spelled out with `chr()` (no string-escape syntax to depend on): space, tab, LF,
 * CR and the non-breaking space U+00A0 (`chr(160)` is that code point in a UTF8 database).
 */
export const staffNameSql = (account: { realName: PgColumn; name: PgColumn }): SQL<string> =>
  sql<string>`coalesce(nullif(btrim(${account.realName}, chr(32) || chr(9) || chr(10) || chr(13) || chr(160)), ''), ${account.name})`;

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
