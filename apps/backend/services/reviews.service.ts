import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { db, intake_items, library, reviews, user, type NewReview, type Review } from '@wxyc/database';
import type { ReviewsActor } from '../utils/review-grants.js';
import { effectiveState } from './intake.service.js';

/**
 * In-app review service behind `/reviews` (BS#2802, slice 10a of BS#2791): a DJ's own
 * draft is created and edited here. Submit and delete are BS#2854.
 */

/** Mirror of the contract's `Review` (`wxyc-shared/api.yaml`); private because Backend-Service stays on `@wxyc/shared` 5.x. */
export type ReviewResponse = Review & { locked: boolean };

/** The contract's `ReviewFields`: the slip plus publishing consent. `undefined` means "not supplied". */
export type ReviewFields = Partial<
  Pick<
    NewReview,
    | 'buzzwords'
    | 'artist_blurb'
    | 'review'
    | 'recommended_tracks'
    | 'fcc'
    | 'publish_website'
    | 'publish_apps'
    | 'publish_instagram'
    | 'credit'
  >
>;

/** The caller; `manage` is whether they hold `reviews: manage`. */

/** `reviews.author` is `varchar(128)`; `auth_user.name` is 255, so a long name is cut to its first 128 code points (Postgres counts characters, not UTF-16 units). */
export const AUTHOR_MAX = 128;
export const snapshotAuthor = (name: string | null | undefined) =>
  name == null ? null : [...name].slice(0, AUTHOR_MAX).join('');

/** `locked` is the item's slip being printed; a review on a library release alone has no item and no slip. */
const locked = sql<boolean>`coalesce(${intake_items.printed_at} IS NOT NULL, false)`;

const selectReview = (id: number, executor: Pick<typeof db, 'select'> = db) =>
  executor
    .select({ ...getTableColumns(reviews), locked: locked.as('locked') })
    .from(reviews)
    .leftJoin(intake_items, eq(intake_items.id, reviews.intake_item_id))
    .where(eq(reviews.id, id))
    .then((rows) => rows[0] as ReviewResponse | undefined);

/**
 * Creates the caller's own `typed` draft about one subject. An intake item must be held by the
 * caller (effective state `checked_out`, `checked_out_by` = caller: reviewing needs the physical
 * record), read FOR UPDATE inside the insert's transaction so a release can't land between check
 * and write; a library release only has to exist. Anything else is `subject_not_held`.
 */
export const createReview = async (
  subject: { intake_item_id?: number; album_id?: number },
  fields: ReviewFields,
  actor: ReviewsActor
) =>
  db.transaction(async (tx) => {
    const held =
      subject.intake_item_id !== undefined
        ? await tx
            .select({ id: intake_items.id })
            .from(intake_items)
            .where(
              and(
                eq(intake_items.id, subject.intake_item_id),
                sql`(${effectiveState}) = 'checked_out'`,
                eq(intake_items.checked_out_by, actor.id)
              )
            )
            .for('update')
        : await tx.select({ id: library.id }).from(library).where(eq(library.id, subject.album_id!));
    if (held.length === 0) return { outcome: 'subject_not_held' as const };
    const [account] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actor.id));
    const [{ id }] = await tx
      .insert(reviews)
      .values({
        ...fields,
        ...subject,
        author: snapshotAuthor(account?.name),
        author_user_id: actor.id,
        medium: 'typed',
        status: 'draft',
      })
      .returning({ id: reviews.id });
    return { outcome: 'created' as const, review: (await selectReview(id, tx))! };
  });

/**
 * Who may edit, as a pure decision. A draft is visible only to its author and whoever recorded
 * it, so anyone else gets `not_found` before any grant matters. Then `reviews: manage` always;
 * otherwise only the author, who is locked out of a submitted review once its item's slip is
 * printed (`locked` is always false on a library-release review, so the author always may).
 */
export const editOutcome = (
  review: Pick<ReviewResponse, 'status' | 'author_user_id' | 'recorded_by_user_id' | 'locked'>,
  actor: ReviewsActor
) => {
  const own = review.author_user_id === actor.id;
  if (review.status === 'draft' && !own && review.recorded_by_user_id !== actor.id) return 'not_found' as const;
  if (actor.manage) return 'allowed' as const;
  if (!own) return 'forbidden' as const;
  return review.status === 'submitted' && review.locked ? ('locked' as const) : ('allowed' as const);
};

/**
 * Edits are decided on rows that cannot change before the write commits. Lock order is item,
 * then review (BS#2854's submit and delete follow it): the item is held FOR SHARE so the print
 * step's `UPDATE intake_items` (which stamps `printed_at`) waits behind this transaction, then the
 * review is locked FOR UPDATE so a submit waits too. The edit rules and the text rule are then
 * evaluated on the locked rows. `intake_item_id` never changes, so reading it unlocked to find
 * the item to lock is safe.
 */
export const updateReview = async (id: number, patch: ReviewFields, actor: ReviewsActor) =>
  db.transaction(async (tx) => {
    const [subject] = await tx.select({ item: reviews.intake_item_id }).from(reviews).where(eq(reviews.id, id));
    if (!subject) return { outcome: 'not_found' as const };
    if (subject.item !== null) {
      await tx.select({ id: intake_items.id }).from(intake_items).where(eq(intake_items.id, subject.item)).for('share');
    }
    const [mine] = await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, id)).for('update');
    if (!mine) return { outcome: 'not_found' as const };
    const current = (await selectReview(id, tx))!;
    const decision = editOutcome(current, actor);
    if (decision !== 'allowed') return { outcome: decision };
    // A print must never produce an empty slip, so a submitted typed review keeps its text.
    const text = patch.review === undefined ? current.review : patch.review;
    if (current.status === 'submitted' && current.medium === 'typed' && text === null) {
      return { outcome: 'text_required' as const };
    }
    const [row] = await tx
      .update(reviews)
      .set({ ...patch, last_modified: sql`now()` })
      .where(eq(reviews.id, id))
      .returning();
    return { outcome: 'updated' as const, review: { ...row, locked: current.locked } as ReviewResponse };
  });
