import * as Sentry from '@sentry/node';
import { eq, sql } from 'drizzle-orm';
import { db, intake_items, member, user } from '@wxyc/database';
import { normalizeRole, sendNotificationEmail } from '@wxyc/authentication';
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

const lineText = (line: AssignedLine) => {
  switch (line.kind) {
    case 'holder':
      return 'This review is from the DJ who has the record.';
    case 'other_dj':
      return `This review is from another DJ; the record is with ${line.holderName ?? 'another DJ'}.`;
    case 'removed_holder':
      return "This review is from another DJ; the record is checked out and its holder's account was removed.";
    case 'pool':
      return 'This review is from another DJ; nobody has the record (it is in the pool).';
  }
};

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

/** The accounts holding the `musicDirector` role (not `stationManager`), by `normalizeRole` rather than a raw role string. */
export const musicDirectorEmails = async (): Promise<string[]> => {
  const rows = await db
    .select({ role: member.role, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId));
  return [...new Set(rows.filter((r) => normalizeRole(r.role) === 'musicDirector').map((r) => r.email))];
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const intakeUrl = (itemId: number) =>
  `${(process.env.FRONTEND_SOURCE?.split(',')[0]?.trim() || 'http://localhost:3000').replace(/\/$/, '')}/dashboard/admin/intake/${itemId}`;

/**
 * One email per music director. A failure is logged and swallowed: the intake pile is the source of truth and
 * the request that triggered the notice still succeeds. `sendNotificationEmail` honors `EMAIL_ENABLED`.
 */
export const notifyMusicDirectors = async (message: { subject: string; lines: string[]; itemId: number }) => {
  try {
    const url = intakeUrl(message.itemId);
    const text = [...message.lines, url].join('\n');
    const html = `${message.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p><a href="${escapeHtml(url)}">Open in the intake pile</a></p>`;
    for (const email of await musicDirectorEmails()) {
      try {
        await sendNotificationEmail({ to: [email], subject: message.subject, text, html });
      } catch (err) {
        Sentry.captureException(err, { tags: { subsystem: 'review-notices' }, extra: { item_id: message.itemId } });
      }
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { subsystem: 'review-notices' }, extra: { item_id: message.itemId } });
  }
};

/** A review of an intake item is waiting to be accepted (the item did not move). */
export const notifyReviewSubmitted = (n: ReviewNotice) =>
  notifyMusicDirectors({
    itemId: n.itemId,
    subject: `Review waiting to be accepted: ${n.artist} - ${n.album}`,
    lines: [
      `A review of ${n.artist} - ${n.album} by ${n.author ?? 'a DJ'} is waiting to be accepted.`,
      lineText(n.line),
    ],
  });

/** A DJ passed on a request; named by their account's display name (`auth_user.name`), never the real name. */
export const notifyPass = async (item: { id: number; artist: string; album: string }, djUserId: string) => {
  // The request already succeeded; a failed name lookup must not turn it into an error.
  const dj = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, djUserId))
    .then(
      (rows) => rows[0],
      () => undefined
    );
  return notifyMusicDirectors({
    itemId: item.id,
    subject: `Passed: ${item.artist} - ${item.album}`,
    lines: [`${dj?.name ?? 'A DJ'} passed on the request for ${item.artist} - ${item.album}.`],
  });
};
