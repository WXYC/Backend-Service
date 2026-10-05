import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  intake_items,
  library,
  review_revisions,
  reviews,
  user,
  type NewReview,
  type Review,
} from '@wxyc/database';
import type { ReviewsActor } from '../utils/review-grants.js';
import { effectiveState } from './intake.service.js';

/**
 * In-app review service behind `/reviews` (BS#2802, slice 10a of BS#2791): a DJ's own
 * draft is created and edited here. Submit and delete are BS#2854.
 */

/** Mirror of the contract's `Review` (`wxyc-shared/api.yaml`); private because Backend-Service stays on `@wxyc/shared` 5.x. */
export type ReviewResponse = Review;

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

/** `reviews.author` is `varchar(128)`; `auth_user.name` is 255, so a long name is cut to its first 128 code points (Postgres counts characters, not UTF-16 units). */
export const AUTHOR_MAX = 128;
export const snapshotAuthor = (name: string | null | undefined) =>
  name == null ? null : [...name].slice(0, AUTHOR_MAX).join('');

const selectReview = (id: number, executor: Pick<typeof db, 'select'> = db) =>
  executor
    .select()
    .from(reviews)
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

const CONTENT_FIELDS = ['review', 'artist_blurb', 'buzzwords', 'recommended_tracks', 'fcc'] as const;
const CONSENT_FIELDS = ['publish_website', 'publish_apps', 'publish_instagram', 'credit'] as const;
type RevisionContent = Pick<Review, (typeof CONTENT_FIELDS)[number]>;
type Tx = Pick<typeof db, 'select' | 'insert'>;

/** The five content fields of a row, as a revision stores them. */
const pickContent = (row: RevisionContent) =>
  Object.fromEntries(CONTENT_FIELDS.map((key) => [key, row[key]])) as RevisionContent;

/**
 * Who may edit, as a pure decision. A draft is visible only to its author and whoever recorded
 * it, so anyone else gets `not_found` before any grant matters. Then `reviews: manage` always
 * may, and the author may at any time (there is no print lock); anyone else is `forbidden`. The
 * consent fields (`touchesConsent`) belong to the author's account alone: a caller who may edit
 * but is not the author, a music director included, is `consent_forbidden`, as is everyone when
 * no account is linked. The two refusals are distinct so a client can tell "drop the consent
 * keys and retry" from "you have no edit right".
 */
export const editOutcome = (
  review: Pick<ReviewResponse, 'status' | 'author_user_id' | 'recorded_by_user_id'>,
  actor: ReviewsActor,
  touchesConsent = false
) => {
  const own = review.author_user_id === actor.id;
  if (review.status === 'draft' && !own && review.recorded_by_user_id !== actor.id) return 'not_found' as const;
  if (!actor.manage && !own) return 'forbidden' as const;
  if (touchesConsent && !own) return 'consent_forbidden' as const;
  return 'allowed' as const;
};

/**
 * Locks a review in the one order every operation on an item and its reviews uses: the intake
 * item first (`itemMode`: `'share'` for edit and submit, which do not write the item; `'update'`
 * for delete), then the review row with a plain `SELECT id ... FOR UPDATE`. Never drizzle's
 * `.for('update', { of: reviews })`, which renders a schema-qualified `FOR UPDATE OF
 * "wxyc_schema"."reviews"` that Postgres rejects. `intake_item_id` never changes, so reading it
 * unlocked to find the item to lock is safe. `undefined` when the review does not exist.
 */
export const lockReviewAfterItem = async (
  tx: Pick<typeof db, 'select'>,
  reviewId: number,
  itemMode: 'share' | 'update'
) => {
  const [subject] = await tx.select({ item: reviews.intake_item_id }).from(reviews).where(eq(reviews.id, reviewId));
  if (!subject) return undefined;
  if (subject.item !== null) {
    await tx.select({ id: intake_items.id }).from(intake_items).where(eq(intake_items.id, subject.item)).for(itemMode);
  }
  const [mine] = await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).for('update');
  return mine ? { itemId: subject.item } : undefined;
};

const highestRevision = async (tx: Pick<typeof db, 'select'>, reviewId: number) => {
  const [{ n }] = await tx
    .select({ n: sql<number>`coalesce(max(${review_revisions.revision}), 0)` })
    .from(review_revisions)
    .where(eq(review_revisions.review_id, reviewId));
  return n;
};

/**
 * Appends the next `review_revisions` row for a review and returns its number, or `undefined`
 * when the review does not exist (as `lockReviewAfterItem` answers), decided on its own lock
 * before anything else is read, so a caller that has not locked the review first can answer
 * `not_found` instead of raising the `review_id` FK. It takes the review lock itself (a plain
 * `SELECT id ... FOR UPDATE`, before it reads the highest revision) so two writers cannot take
 * one number, and so `deleteAlbumFromDB`'s capture, which holds `FOR SHARE` on a release's
 * reviews before it reads their revisions, never misses one: a writer holding only the FK's `FOR
 * KEY SHARE` could slip a row in. Inside `updateReview` the row is already locked, so this
 * changes nothing there. It does not lock the intake item: lock order stays the caller's job,
 * through `lockReviewAfterItem`. `editor.name` is a snapshot (`snapshotAuthor`); `at` defaults
 * to the column's `now()`.
 */
export const writeReviewRevision = async (
  tx: Tx,
  reviewId: number,
  content: RevisionContent,
  editor: { name: string | null; userId: string | null; at?: Date }
) => {
  const [locked] = await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).for('update');
  if (!locked) return undefined;
  const revision = (await highestRevision(tx, reviewId)) + 1;
  await tx.insert(review_revisions).values({
    ...content,
    review_id: reviewId,
    revision,
    edited_by: editor.name,
    edited_by_user_id: editor.userId,
    ...(editor.at === undefined ? {} : { edited_at: editor.at }),
  });
  return revision;
};

/**
 * Edits are decided on rows that cannot change before the write commits: `lockReviewAfterItem`
 * (item `FOR SHARE`, then the review `FOR UPDATE`), then the edit rules and the text rule on the
 * locked row. An edit of a submitted review that changes a content field also appends a
 * revision; a draft edit or a consent-only edit does not. A submitted review with no history
 * first gets revision 1: its content before this edit, attributed to its author, at
 * `submitted_at`, or at `last_modified` when `submitted_at` is NULL (a row whose `status` came
 * from the column default has none). `last_modified` is the row's last write before this edit, a
 * consent-only patch included, so it is a bound on the content's age rather than its exact time;
 * it is NOT NULL and earlier than this edit, so the history never shows the author's text stamped
 * at the moment of someone else's edit. The response is read back through `selectReview` after
 * all writes.
 */
export const updateReview = async (id: number, patch: ReviewFields, actor: ReviewsActor) =>
  db.transaction(async (tx) => {
    if (!(await lockReviewAfterItem(tx, id, 'share'))) return { outcome: 'not_found' as const };
    const current = (await selectReview(id, tx))!;
    const touchesConsent = CONSENT_FIELDS.some((key) => patch[key] !== undefined);
    const decision = editOutcome(current, actor, touchesConsent);
    if (decision !== 'allowed') return { outcome: decision };
    // A print must never produce an empty slip, so a submitted typed review keeps its text.
    const text = patch.review === undefined ? current.review : patch.review;
    if (current.status === 'submitted' && current.medium === 'typed' && text === null) {
      return { outcome: 'text_required' as const };
    }
    const revises =
      current.status === 'submitted' &&
      CONTENT_FIELDS.some((key) => patch[key] !== undefined && patch[key] !== current[key]);
    let editor: { name: string | null; userId: string } | undefined;
    if (revises) {
      const [account] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actor.id));
      editor = { name: snapshotAuthor(account?.name), userId: actor.id };
      if ((await highestRevision(tx, id)) === 0) {
        await writeReviewRevision(tx, id, pickContent(current), {
          name: current.author,
          userId: current.author_user_id,
          at: current.submitted_at ?? current.last_modified,
        });
      }
    }
    const [row] = await tx
      .update(reviews)
      .set({ ...patch, last_modified: sql`now()` })
      .where(eq(reviews.id, id))
      .returning();
    if (editor) await writeReviewRevision(tx, id, pickContent(row), editor);
    return { outcome: 'updated' as const, review: (await selectReview(id, tx))! };
  });
