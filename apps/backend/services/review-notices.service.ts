import * as Sentry from '@sentry/node';
import { eq, sql } from 'drizzle-orm';
import { db, intake_items, member, user } from '@wxyc/database';
import { isBanInForce, normalizeRole, sendNotificationEmail } from '@wxyc/authentication';
import { effectiveState, type IntakeItemState } from './intake.service.js';

/** Who has the record a waiting review is about, relative to the review's author (BS#2806). */
export type AssignedLine =
  { kind: 'holder' } | { kind: 'other_dj'; holderName: string | null } | { kind: 'removed_holder' } | { kind: 'pool' };

export type NoticeItem = {
  checked_out_at: Date | null;
  checked_out_by: string | null;
  requested_dj_id: string | null;
  effective_state: IntakeItemState;
};

/**
 * The four cases of the assigned line. A record is out when `checked_out_at` is set (epic decision 38) and its
 * holder is `checked_out_by`, which is NULL once that DJ's account is deleted — still out, never the pool. A live
 * request (effective state `requested`) is held by the requested DJ; an expired one reads as the pool. An author
 * with no linked account is never the holder.
 */
export const assignedLine = (
  item: NoticeItem,
  authorUserId: string | null,
  holderName: string | null
): AssignedLine => {
  if (item.checked_out_at !== null && item.checked_out_by === null) return { kind: 'removed_holder' };
  const holder = item.checked_out_at !== null ? item.checked_out_by : requestedHolder(item);
  if (holder === null) return { kind: 'pool' };
  return authorUserId === holder ? { kind: 'holder' } : { kind: 'other_dj', holderName };
};

const requestedHolder = (item: NoticeItem) => (item.effective_state === 'requested' ? item.requested_dj_id : null);

/** The assigned line's sentence, in the copy the station decided on 2026-10-06 (BS#2806). */
const lineText = (line: AssignedLine) => {
  switch (line.kind) {
    case 'holder':
      return 'This review is from the DJ who has the record.';
    case 'other_dj':
      return line.holderName === null
        ? 'This review is from another DJ; the record is checked out to a different DJ.'
        : `This review is from another DJ; the record is with ${line.holderName}.`;
    case 'removed_holder':
      return "This review is from another DJ; the record is checked out and its holder's account was removed.";
    case 'pool':
      return 'This review is from another DJ; nobody has the record checked out.';
  }
};

/** `{artist} – {album}`, joined by an en dash, never a hyphen. */
const record = (artist: string, album: string) => `${artist} – ${album}`;

export type ReviewNotice = { itemId: number; artist: string; album: string; author: string | null; line: AssignedLine };

/** Reads the item as the submit saw it: call inside the submit's transaction, after its locks. */
export const readReviewNotice = async (
  tx: Pick<typeof db, 'select'>,
  itemId: number,
  review: { author: string | null; author_user_id: string | null }
): Promise<ReviewNotice | undefined> => {
  const [row] = await tx
    .select({
      artist: intake_items.artist_name,
      album: intake_items.album_title,
      checked_out_at: intake_items.checked_out_at,
      checked_out_by: intake_items.checked_out_by,
      requested_dj_id: intake_items.requested_dj_id,
      effective_state: effectiveState,
      holder_name: user.name,
    })
    .from(intake_items)
    .leftJoin(
      user,
      eq(
        user.id,
        sql`CASE WHEN ${intake_items.checked_out_at} IS NOT NULL THEN ${intake_items.checked_out_by} ELSE CASE WHEN (${effectiveState}) = 'requested' THEN ${intake_items.requested_dj_id} END END`
      )
    )
    .where(eq(intake_items.id, itemId));
  if (!row) return undefined;
  const line = assignedLine(row, review.author_user_id, row.holder_name);
  return { itemId, artist: row.artist, album: row.album, author: review.author, line };
};

/**
 * The accounts holding the `musicDirector` role (not `stationManager`), by `normalizeRole` rather than a raw role
 * string, less any account banned in better-auth (`auth_user.banned`): a banned account is told nothing.
 */
export const musicDirectorEmails = async (): Promise<string[]> => {
  const rows = await db
    .select({ role: member.role, email: user.email, banned: user.banned, banExpires: user.banExpires })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId));
  return [
    ...new Set(rows.filter((r) => normalizeRole(r.role) === 'musicDirector' && !isBanInForce(r)).map((r) => r.email)),
  ];
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const intakeUrl = (itemId: number) =>
  `${(process.env.FRONTEND_SOURCE?.split(',')[0]?.trim() || 'http://localhost:3000').replace(/\/$/, '')}/dashboard/admin/intake/${itemId}`;

const reportFailure = (err: unknown, itemId: number) => {
  console.error('[review-notices] Failed to notify the music directors:', err);
  Sentry.captureException(err, { tags: { subsystem: 'review-notices' }, extra: { item_id: itemId } });
};

/**
 * One email per music director, sent concurrently. Never rejects: every failure is logged and reported to Sentry
 * and swallowed, because the intake pile is the source of truth. Callers start a notice after the commit and do
 * not await it (as `auth.definition.ts` does the password-reset send), so a slow or hung SES never delays or fails
 * a request that already committed. `sendNotificationEmail` honors `EMAIL_ENABLED`.
 */
export const notifyMusicDirectors = async (message: { subject: string; lines: string[]; itemId: number }) => {
  try {
    const url = intakeUrl(message.itemId);
    const text = [...message.lines, url].join('\n');
    const html = `${message.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p><a href="${escapeHtml(url)}">Open in the Pile</a></p>`;
    const sends = (await musicDirectorEmails()).map(async (email) =>
      sendNotificationEmail({ to: [email], subject: message.subject, text, html })
    );
    for (const sent of await Promise.allSettled(sends)) {
      if (sent.status === 'rejected') reportFailure(sent.reason, message.itemId);
    }
  } catch (err) {
    reportFailure(err, message.itemId);
  }
};

/** A review of an intake item is waiting to be accepted (the item did not move). */
export const notifyReviewSubmitted = (n: ReviewNotice) =>
  notifyMusicDirectors({
    itemId: n.itemId,
    subject: `Review waiting to be accepted: ${record(n.artist, n.album)}`,
    lines: [
      `A review of ${record(n.artist, n.album)} by ${n.author ?? 'a DJ'} is waiting to be accepted.`,
      lineText(n.line),
    ],
  });

/** A DJ passed on a request; named by their account's display name (`auth_user.name`), never the real name. */
export const notifyPass = async (item: { id: number; artist: string; album: string }, djUserId: string) => {
  // The request already succeeded; a failed name lookup sends the notice without the name, never an error.
  const dj = await Promise.resolve()
    .then(() => db.select({ name: user.name }).from(user).where(eq(user.id, djUserId)))
    .then(
      (rows) => rows[0],
      () => undefined
    );
  return notifyMusicDirectors({
    itemId: item.id,
    subject: `Request passed: ${record(item.artist, item.album)}`,
    lines: [
      `${dj?.name ?? 'A DJ'} passed on the request for ${record(item.artist, item.album)}. Any DJ can take it now.`,
    ],
  });
};
