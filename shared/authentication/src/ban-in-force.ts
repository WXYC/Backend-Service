/**
 * Whether a better-auth ban is in force: `banned` is set and `banExpires` is unset or still ahead. An expired ban counts
 * as lifted even though `auth_user.banned` stays true, because better-auth clears the flag only at the account's next
 * sign-in. An expiry that is not a valid date (a hand-written `'infinity'` reads back as an Invalid Date) keeps the ban in
 * force: fail closed.
 */
export const isBanInForce = (account: { banned: boolean | null; banExpires: Date | null }, now = Date.now()): boolean =>
  account.banned === true && (account.banExpires === null || !(account.banExpires.getTime() <= now));
