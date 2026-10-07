import * as Sentry from '@sentry/node';
import { eq, sql } from 'drizzle-orm';
import { db, intake_items, member, user } from '@wxyc/database';
import { isBanInForce, normalizeRole, sendNotificationEmail } from '@wxyc/authentication';
import type { FccNoteResponse } from './fcc-notes.service.js';
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

const absoluteUrl = (path: string) =>
  `${(process.env.FRONTEND_SOURCE?.split(',')[0]?.trim() || 'http://localhost:3000').replace(/\/$/, '')}${path}`;

const reportFailure = (err: unknown, context: Record<string, unknown>) => {
  console.error('[review-notices] Failed to send a review notice:', err);
  Sentry.captureException(err, { tags: { subsystem: 'review-notices' }, extra: context });
};

type NoticeLink = { path: string; label: string };
type Notice = { subject: string; lines: string[]; links: NoticeLink[]; context: Record<string, unknown> };

/** The link to an intake item in the Pile, for the notices about one. */
const itemLink = (itemId: number): NoticeLink => ({
  path: `/dashboard/admin/intake/${itemId}`,
  label: 'Open in the Pile',
});

/** Plain text: the lines, then each link's full URL on its own line. HTML: the lines, then one paragraph per anchor. One home, so the two senders cannot drift. */
const render = ({ lines, links }: Pick<Notice, 'lines' | 'links'>) => ({
  text: [...lines, ...links.map((l) => absoluteUrl(l.path))].join('\n'),
  html:
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
    links.map((l) => `<p><a href="${escapeHtml(absoluteUrl(l.path))}">${escapeHtml(l.label)}</a></p>`).join(''),
});

/**
 * One email per music director, sent concurrently. Never rejects: every failure is logged and reported to Sentry
 * (`context` is its `extra`) and swallowed, because the intake Pile is the source of truth. Callers start a notice after the commit and do
 * not await it (as `auth.definition.ts` does the password-reset send), so a slow or hung SES never delays or fails
 * a request that already committed. Each link's `path` is joined to the frontend's base URL in `render`, which stays private.
 * `sendNotificationEmail` honors `EMAIL_ENABLED`.
 */
export const notifyMusicDirectors = async (message: Notice) => {
  try {
    const { text, html } = render(message);
    const sends = (await musicDirectorEmails()).map(async (email) =>
      sendNotificationEmail({ to: [email], subject: message.subject, text, html })
    );
    for (const sent of await Promise.allSettled(sends)) {
      if (sent.status === 'rejected') reportFailure(sent.reason, message.context);
    }
  } catch (err) {
    reportFailure(err, message.context);
  }
};

/**
 * One email to one account's own address (BS#2864), through the same renderer and failure handling as
 * `notifyMusicDirectors`. Sends nothing when the account is gone or its ban is in force (`isBanInForce`: it cannot
 * sign in to follow the link). Never rejects.
 */
export const notifyAccount = async (userId: string, message: Notice) => {
  try {
    const [account] = await db
      .select({ email: user.email, banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, userId));
    if (!account || isBanInForce(account)) return;
    await sendNotificationEmail({ to: [account.email], subject: message.subject, ...render(message) });
  } catch (err) {
    reportFailure(err, message.context);
  }
};

/** A review of an intake item is waiting to be accepted (the item did not move). */
export const notifyReviewSubmitted = (n: ReviewNotice) =>
  notifyMusicDirectors({
    links: [itemLink(n.itemId)],
    context: { item_id: n.itemId },
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
    links: [itemLink(item.id)],
    context: { item_id: item.id },
    subject: `Request passed: ${record(item.artist, item.album)}`,
    lines: [
      `${dj?.name ?? 'A DJ'} passed on the request for ${record(item.artist, item.album)}. Any DJ can take it now.`,
    ],
  });
};

/** What the create hands back for the FCC-note notice: the note, the record it is on, and the reporter's user id. */
export type FccNoteNotice = { note: FccNoteResponse; artist: string; album: string; reporterUserId: string };

/** A DJ reported an FCC note; the music directors confirm it on their intake page. The reporter is `note.reported_by`, the account-name snapshot. */
export const notifyFccNoteReported = ({ note, artist, album }: FccNoteNotice) =>
  notifyMusicDirectors({
    subject: `FCC note to confirm: ${record(artist, album)}`,
    lines: [`${note.reported_by} reported an FCC note on ${record(artist, album)}.`, `${note.track}: ${note.note}`],
    links: [{ path: '/dashboard/admin/intake', label: 'Open FCC notes to confirm' }],
    context: { fcc_note_id: note.id },
  });

/** The record a review is about, named for the email (`{artist} – {album}`). */
export type NoticeRecord = { artist: string; album: string };

/** A review's author is told a music director edited it, or recorded it in their name; `name` is the account name (`auth_user.name`), null when it has none. */
export type AuthorNotice = NoticeRecord & { reviewId: number; authorUserId: string; name: string | null };

const reviewLink = (reviewId: number): NoticeLink => ({
  path: `/dashboard/reviews/${reviewId}`,
  label: 'Open your review',
});

/** Notice 1: a music director edited the review of an account. */
export const notifyReviewEdited = (n: AuthorNotice) =>
  notifyAccount(n.authorUserId, {
    subject: `Your review was edited: ${record(n.artist, n.album)}`,
    lines: [
      `${n.name ?? 'A music director'} edited your review of ${record(n.artist, n.album)}. The review's history shows what changed.`,
    ],
    links: [reviewLink(n.reviewId)],
    context: { review_id: n.reviewId },
  });

/** Notice 2: a music director recorded a review in the account's name. */
export const notifyReviewRecorded = (n: AuthorNotice) =>
  notifyAccount(n.authorUserId, {
    subject: `A review was recorded in your name: ${record(n.artist, n.album)}`,
    lines: [
      `${n.name ?? 'A music director'} recorded a review of ${record(n.artist, n.album)} in your name.`,
      "You can edit it, and it isn't published anywhere until you choose where it can appear and how you're credited.",
    ],
    links: [reviewLink(n.reviewId)],
    context: { review_id: n.reviewId },
  });
