import { and, desc, eq, getTableColumns, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  db,
  extractConstraintName,
  extractSqlState,
  artists,
  intake_items,
  library,
  member,
  readStaffName,
  staffNameSql,
  review_prints,
  review_revisions,
  reviews,
  user,
  type NewReview,
  type Review,
} from '@wxyc/database';
import { isBanInForce } from '@wxyc/authentication';
import { canBeAskedToReview, type ReviewsActor } from '../utils/review-grants.js';
import { outerRef } from '../utils/sql-fragments.js';
import {
  FILED_STATES,
  RELEASE_ACCEPTED_REVIEW,
  effectiveState,
  lockRecordSubject,
  writeAcceptance,
} from './intake.service.js';
import {
  readReviewNotice,
  type AuthorNotice,
  type FccChangeNotice,
  type PrintedCopy,
} from './review-notices.service.js';
import { lockReleaseRow } from '../utils/release-row-lock.js';
import type { RecordSubject } from '../utils/record-subject.js';

/**
 * In-app review service behind `/reviews` (BS#2802, slice 10a of BS#2791): a DJ's own
 * draft is created, edited, submitted and deleted here (submit and delete are BS#2854).
 */

/**
 * Mirror of the contract's `Review` (`wxyc-shared/api.yaml`); private because Backend-Service stays on `@wxyc/shared` 5.x.
 * The last five keys are computed by `reviewSelection`, never stored.
 */
export type ReviewResponse = Review & {
  in_use: boolean;
  on_cover: boolean;
  printed_revision_id: number | null;
  printed_at: Date | null;
  revision_count: number;
};

/** Mirror of the contract's `ReviewRevision`: one saved version of a submitted review's slip content. Consent fields are not versioned. */
export type ReviewRevisionResponse = typeof review_revisions.$inferSelect;

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

/** Re-exported for the controller's `author` length check; the stamp cut itself lives with `readStaffName`. */
export { AUTHOR_MAX } from '@wxyc/database';

/**
 * SQL for "review `reviewId` is the newest print of a copy": of an intake item, or, with no item, of a library
 * release. A print with no item stops counting once its release has exactly one filed or finalized copy (BS#3075, decided by
 * the station 2026-10-09: that copy's review is the one cover, with no exception for an older physical copy): nothing
 * physical depends on the item-less print any more, so it neither covers nor holds the review (`in_use`). With no copy, or
 * two or more, it counts as before. `reviewId` must be a nested SQL, such as `outerRef(column)` or a bound parameter (`deleteReview`
 * passes one), never a bare `Column`: drizzle renders a bare column unqualified in a single-table select and it
 * would bind to the inner `p`. `scope` narrows which
 * prints count, through the `id`, `intake_item_id` and `album_id` of `p` (`on_cover` asks only about the prints of one
 * release's copies; `printedCopies` pins `p.id` to the one print row of its outer select, so each copy is one row). Shared by `in_use` here, by `deleteReview`'s print half,
 * by `on_cover` and by `printedCopies`, so they cannot disagree.
 */
export const latestPrintOfCopy = (
  reviewId: SQL,
  scope?: (p: { id: AnyColumn; intake_item_id: AnyColumn; album_id: AnyColumn }) => SQL
) => {
  const p = alias(review_prints, 'p');
  const n = alias(review_prints, 'n');
  return sql`EXISTS (SELECT 1 FROM ${review_prints} AS p WHERE ${p.review_id} = ${reviewId}${scope ? sql` AND ${scope(p)}` : sql``} AND (${p.intake_item_id} IS NOT NULL OR (SELECT count(*) FROM ${intake_items} AS oc WHERE oc.album_id = ${p.album_id} AND oc.state IN ('filed', 'finalized')) <> 1) AND NOT EXISTS (SELECT 1 FROM ${review_prints} AS n WHERE ${n.intake_item_id} IS NOT DISTINCT FROM ${p.intake_item_id} AND (${p.intake_item_id} IS NOT NULL OR ${n.album_id} = ${p.album_id}) AND (${n.printed_at}, ${n.id}) > (${p.printed_at}, ${p.id})))`;
};

const reviewRef = outerRef(reviews.id);
const acceptedBy = (scope: SQL) =>
  sql`EXISTS (SELECT 1 FROM ${intake_items} AS ai WHERE ai.accepted_review_id = ${reviewRef} AND ${scope})`;
const inUse = sql<boolean>`(${acceptedBy(sql`true`)} OR ${latestPrintOfCopy(reviewRef)})`;
const ownLatestPrint = (column: 'revision_id' | 'printed_at') =>
  sql`(SELECT ${sql.raw(`lp.${column}`)} FROM ${review_prints} AS lp WHERE lp.review_id = ${reviewRef} ORDER BY lp.printed_at DESC, lp.id DESC LIMIT 1)`;

// Through `reviewRef`, never a bare `${reviews.id}`: in a single-table select that renders unqualified and would bind to `rr.id`.
const revisionCount = sql<number>`(SELECT count(*)::int FROM ${review_revisions} AS rr WHERE rr.review_id = ${reviewRef})`;

/** A review's columns plus the computed `in_use`, `on_cover` (`onCover`, false unless a release list supplies it), `printed_revision_id`, `printed_at`, `revision_count`. */
const reviewSelection = (onCover: SQL<boolean> = sql`false`) => ({
  ...getTableColumns(reviews),
  in_use: inUse,
  on_cover: onCover.as('on_cover'),
  printed_revision_id: ownLatestPrint('revision_id').mapWith(Number),
  printed_at: ownLatestPrint('printed_at').mapWith(review_prints.printed_at),
  revision_count: revisionCount,
});

/**
 * The read rule: a draft is visible only to its author and whoever recorded it. Everyone else, a music
 * director included, sees submitted reviews only. Exported for the release print (BS#2865) and the history read (BS#2861).
 */
export const reviewVisibleTo = (actor: Pick<ReviewsActor, 'id'>) =>
  sql`(${reviews.status} <> 'draft' OR ${reviews.author_user_id} = ${actor.id} OR ${reviews.recorded_by_user_id} = ${actor.id})`;

const selectReview = (id: number, executor: Pick<typeof db, 'select'> = db) =>
  executor
    .select(reviewSelection())
    .from(reviews)
    .where(eq(reviews.id, id))
    .then((rows) => rows[0] as ReviewResponse | undefined);

/** `GET /reviews/{id}`: `undefined` for a missing review and for a draft the caller may not see. Reads never lock. */
export const getReview = async (id: number, actor: ReviewsActor) =>
  db
    .select(reviewSelection())
    .from(reviews)
    .where(and(eq(reviews.id, id), reviewVisibleTo(actor)))
    .then((rows) => rows[0] as ReviewResponse | undefined);

/**
 * `GET /reviews/{id}/revisions` (BS#2861): newest first; `undefined` for a missing review and for a draft the caller
 * may not see (`reviewVisibleTo`, the rule `getReview` applies). A visible draft has no history: `[]`. Never locks.
 * `edited_by` is Mixed PII (`docs/pii.md`): returned here only, never logged.
 */
export const listReviewRevisions = async (id: number, actor: ReviewsActor) => {
  const [visible] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.id, id), reviewVisibleTo(actor)));
  if (!visible) return undefined;
  return (await db
    .select()
    .from(review_revisions)
    .where(eq(review_revisions.review_id, id))
    .orderBy(desc(review_revisions.revision))) as ReviewRevisionResponse[];
};

/**
 * The release-membership rule of `GET /reviews?album_id=`: the review is the release's own (`reviews.album_id`) or
 * belongs to a release a `filed`/`finalized` item of it cites. `POST /library/{id}/print` (BS#2865) decides by it too.
 */
export const reviewInReleaseList = (albumId: number): SQL => {
  const cited = sql`(SELECT ci.cited_album_id FROM ${intake_items} AS ci WHERE ci.album_id = ${albumId} AND ci.state IN ('filed', 'finalized') AND ci.cited_album_id IS NOT NULL)`;
  return sql`(${reviews.album_id} = ${albumId} OR ${reviews.album_id} IN ${cited})`;
};

export type ReviewFilters = { album_id?: number; intake_item_id?: number; mine?: boolean };

/**
 * `GET /reviews`: one statement. Filters combine with AND; the read rule always applies. Newest first
 * (`submitted_at`, a visible draft by `last_modified`, then `id`). With `album_id` the release's reviews are
 * `reviews.album_id` = the release plus those of the release an item filed as it cites; the reviews on the
 * cover of this release (`on_cover`: accepted for, or the latest print of, a copy of it, or its latest print with no item while it does not have exactly one copy) lead, and the SAME
 * `on_cover` select alias is the first sort key, so the field and the order cannot disagree.
 */
export const listReviews = async (filters: ReviewFilters, actor: ReviewsActor) => {
  const conditions: SQL[] = [reviewVisibleTo(actor)];
  if (filters.mine)
    conditions.push(or(eq(reviews.author_user_id, actor.id), eq(reviews.recorded_by_user_id, actor.id))!);
  if (filters.intake_item_id !== undefined) conditions.push(eq(reviews.intake_item_id, filters.intake_item_id));
  const newest = [desc(sql`coalesce(${reviews.submitted_at}, ${reviews.last_modified})`), desc(reviews.id)];
  if (filters.album_id === undefined) {
    return (await db
      .select(reviewSelection())
      .from(reviews)
      .where(and(...conditions))
      .orderBy(...newest)) as ReviewResponse[];
  }
  const releaseCopies = sql`(SELECT ci.id FROM ${intake_items} AS ci WHERE ci.album_id = ${filters.album_id} AND ci.state IN ('filed', 'finalized'))`;
  conditions.push(reviewInReleaseList(filters.album_id));
  const onCover = sql<boolean>`(${acceptedBy(sql`ai.album_id = ${filters.album_id} AND ai.state IN ('filed', 'finalized')`)} OR ${latestPrintOfCopy(
    reviewRef,
    (p) =>
      sql`(${p.intake_item_id} IN ${releaseCopies} OR (${p.intake_item_id} IS NULL AND ${p.album_id} = ${filters.album_id}))`
  )})`;
  return (await db
    .select(reviewSelection(onCover))
    .from(reviews)
    .where(and(...conditions))
    .orderBy(desc(sql`on_cover`), ...newest)) as ReviewResponse[];
};

/**
 * Creates the caller's own `typed` draft about one subject. An intake item must be held by the
 * caller (effective state `checked_out` or `reviewed`, `checked_out_by` = caller: reviewing needs the physical
 * record, and accepting a review leaves the holder on file, so a DJ still holding a reviewed record may write theirs), read FOR UPDATE inside the insert's transaction so a release can't land between check
 * and write; a library release only has to exist, read FOR KEY SHARE in the same transaction so a concurrent delete
 * waits or has already removed it. Anything else is `subject_not_held`.
 */
export const createReview = async (subject: RecordSubject, fields: ReviewFields, actor: ReviewsActor) =>
  db.transaction(async (tx) => {
    const held =
      subject.intake_item_id !== undefined
        ? (
            await tx
              .select({ id: intake_items.id })
              .from(intake_items)
              .where(
                and(
                  eq(intake_items.id, subject.intake_item_id),
                  sql`(${effectiveState}) IN ('checked_out', 'reviewed')`,
                  eq(intake_items.checked_out_by, actor.id)
                )
              )
              .for('update')
          ).length > 0
        : await lockReleaseRow(tx, subject.album_id);
    if (!held) return { outcome: 'subject_not_held' as const };
    const author = await readStaffName(tx, actor.id);
    const [{ id }] = await tx
      .insert(reviews)
      .values({
        ...fields,
        ...subject,
        author,
        author_user_id: actor.id,
        medium: 'typed',
        status: 'draft',
      })
      .returning({ id: reviews.id });
    return { outcome: 'created' as const, review: (await selectReview(id, tx))! };
  });

/**
 * A release's own record: the one home of the displayed-artist rule. The artist is `alternate_artist_name`, else the
 * artist's name, as filing hands it to enrichment (`library-filing.service.ts`, `library.controller.ts`), so a
 * compilation under a V/A bucket names its own artist. Used by the release print's slip and by the review notices.
 */
export const selectReleaseRecord = (tx: Pick<typeof db, 'select'>, albumId: number) =>
  tx
    .select({
      artist_name: sql<string>`coalesce(nullif(${library.alternate_artist_name}, ''), ${artists.artist_name})`,
      album_title: library.album_title,
      record_label: library.label,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .where(eq(library.id, albumId));

/**
 * The record a review is about, as the notices name it: the item's artist and album, else the release's displayed
 * artist and title (`selectReleaseRecord`). `undefined` when it is gone.
 */
const recordNames = async (tx: Pick<typeof db, 'select'>, review: Pick<Review, 'intake_item_id' | 'album_id'>) => {
  if (review.intake_item_id !== null) {
    const [item] = await tx
      .select({ artist: intake_items.artist_name, album: intake_items.album_title })
      .from(intake_items)
      .where(eq(intake_items.id, review.intake_item_id));
    return item;
  }
  const [release] = await selectReleaseRecord(tx, review.album_id!);
  return release && { artist: release.artist_name, album: release.album_title };
};

/**
 * The copies whose sleeve slip is now out of date (BS#2864): those whose latest print is `reviewId` (the print half of
 * `in_use`, through `latestPrintOfCopy` itself, one print row at a time, so each copy is one row) and whose printed
 * revision's `fcc` differs from `newFcc`. The slip carries the `fcc` of the revision that was printed
 * (`review_prints.revision_id`, as `printSlip` writes it), so a line edited away and back leaves a sleeve that still
 * shows it current. A print whose revision is gone (`revision_id` set NULL) is of unknown content and is listed. An
 * intake item when the print has one, even when it also carries the filed release's id, else the release.
 */
const printedCopies = async (tx: Pick<typeof db, 'select'>, reviewId: number, newFcc: string | null) => {
  const rp = alias(review_prints, 'rp');
  const printed = alias(review_revisions, 'printed');
  const rows = await tx
    .select({ item: rp.intake_item_id, album: rp.album_id, revision: rp.revision_id, printedFcc: printed.fcc })
    .from(rp)
    .leftJoin(printed, eq(printed.id, rp.revision_id))
    .where(
      and(
        eq(rp.review_id, reviewId),
        latestPrintOfCopy(sql`${reviewId}::int`, (p) => sql`${p.id} = ${rp.id}`)
      )
    )
    .orderBy(rp.printed_at, rp.id);
  return rows
    .filter(({ revision, printedFcc }) => revision === null || printedFcc !== newFcc)
    .map(({ item, album }): PrintedCopy => (item !== null ? { intake_item_id: item } : { album_id: album! }));
};

/** The on-behalf keys of `POST /reviews` (slice 13e): the free-text `author`, an optional linked account, the medium, and whether the review is accepted at once. */
export type OnBehalf = { author: string; author_user_id?: string; medium: 'typed' | 'handwritten'; accept: boolean };

/** A foreign-key miss on `reviews.author_user_id` (23503): the linked account no longer exists. Any other 23503 stays a 500. */
const isUnknownAuthor = (error: unknown) =>
  extractSqlState(error) === '23503' && extractConstraintName(error)?.includes('author_user_id') === true;

/**
 * `POST /reviews` for a caller with `reviews: manage` who sends the on-behalf keys (slice 13e). Recorded by
 * the caller (`recorded_by_user_id`) for the typed `author`, whom `author_user_id` may link to an account (an
 * unknown one is `unknown_author`); nothing is ticked for publishing and `credit` stays null, because the author
 * never saw the question (the controller refuses fields that say otherwise). The subject is exempt from the
 * hold rule (`lockRecordSubject`). A typed review accepted at once needs text (`text_required`, before any
 * lock). With `accept` the draft is submitted and accepted for the item in the same transaction, through the
 * writes `submitReview` and `acceptReview` use. The notice to a linked DJ (BS#2864) goes after commit, at the caller.
 */
export const recordReview = async (
  subject: RecordSubject,
  fields: ReviewFields,
  onBehalf: OnBehalf,
  actor: ReviewsActor
) => {
  const { accept, author_user_id, ...recorded } = onBehalf;
  if (accept && recorded.medium === 'typed' && fields.review == null) return { outcome: 'text_required' as const };
  try {
    return await db.transaction(async (tx) => {
      const target = await lockRecordSubject(tx, subject, accept ? 'update' : 'share');
      if (!target) return { outcome: 'subject_not_held' as const };
      if (author_user_id !== undefined) {
        const linked = await tx.select({ id: user.id }).from(user).where(eq(user.id, author_user_id));
        if (linked.length === 0) return { outcome: 'unknown_author' as const };
      }
      const [row] = await tx
        .insert(reviews)
        .values({
          ...fields,
          ...target,
          ...recorded,
          author_user_id: author_user_id ?? null,
          recorded_by_user_id: actor.id,
          status: 'draft',
        })
        .returning();
      if (accept && subject.intake_item_id !== undefined) {
        await writeSubmission(tx, row);
        await writeAcceptance(tx, subject.intake_item_id, row.id, actor);
      }
      const review = (await selectReview(row.id, tx))!;
      // Notice 2 (BS#2864): the linked account, unless it is the recorder's own.
      let notice: AuthorNotice | undefined;
      if (author_user_id !== undefined && author_user_id !== actor.id) {
        const names = await recordNames(tx, row);
        if (names) {
          notice = {
            ...names,
            reviewId: row.id,
            authorUserId: author_user_id,
            name: await readStaffName(tx, actor.id),
          };
        }
      }
      return { outcome: 'created' as const, review, notice };
    });
  } catch (error) {
    // The account was deleted between the check above and this insert: the same answer as the check gives, not a 500.
    if (isUnknownAuthor(error)) return { outcome: 'unknown_author' as const };
    throw error;
  }
};

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
 * unlocked to find the item to lock is safe. With `acceptingItems` (delete, which writes every item
 * that accepts the review) the ids of those items are read unlocked too, and the review's own item
 * and all of them are locked in one statement, ascending by id, so two deletes cannot take the same
 * items in opposite orders. An accept that lands after that read is handled by the caller, which
 * reads the accepting items again once the review is locked. `undefined` when the review does not exist.
 */
export const lockReviewAfterItem = async (
  tx: Pick<typeof db, 'select'>,
  reviewId: number,
  itemMode: 'share' | 'update',
  { acceptingItems = false }: { acceptingItems?: boolean } = {}
) => {
  const [subject] = await tx.select({ item: reviews.intake_item_id }).from(reviews).where(eq(reviews.id, reviewId));
  if (!subject) return undefined;
  const itemIds = new Set(subject.item === null ? [] : [subject.item]);
  if (acceptingItems) {
    const accepting = await tx
      .select({ id: intake_items.id })
      .from(intake_items)
      .where(eq(intake_items.accepted_review_id, reviewId));
    accepting.forEach((row) => itemIds.add(row.id));
  }
  if (itemIds.size > 0) {
    await tx
      .select({ id: intake_items.id })
      .from(intake_items)
      .where(
        inArray(
          intake_items.id,
          [...itemIds].sort((a, b) => a - b)
        )
      )
      .orderBy(intake_items.id)
      .for(itemMode);
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
 * through `lockReviewAfterItem`. `editor.name` is a snapshot (`readStaffName`); `at` defaults
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
 * Writes revision 1 for a submitted review that has no history, from its locked row: its five content fields as they
 * are now, attributed to `author` and `author_user_id`, dated `submitted_at`, or `last_modified` when `submitted_at`
 * is NULL (a row whose `status` came from the column default has none). Answers the number it wrote, or `undefined`
 * when the review already has history. The one home of that rule, for the first edit (`updateReview`) and the print.
 */
export const writeFirstRevisionIfMissing = async (
  tx: Tx,
  review: RevisionContent & Pick<Review, 'id' | 'author' | 'author_user_id' | 'submitted_at' | 'last_modified'>
) =>
  (await highestRevision(tx, review.id)) === 0
    ? writeReviewRevision(tx, review.id, pickContent(review), {
        name: review.author,
        userId: review.author_user_id,
        at: review.submitted_at ?? review.last_modified,
      })
    : undefined;

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
    // A review never printed (`printed_at` NULL) is on no sleeve, so the copies are not even read.
    const fccChanged = revises && patch.fcc !== undefined && patch.fcc !== current.fcc && current.printed_at != null;
    let editor: { name: string | null; userId: string } | undefined;
    if (revises) {
      editor = { name: await readStaffName(tx, actor.id), userId: actor.id };
      await writeFirstRevisionIfMissing(tx, current);
    }
    const [row] = await tx
      .update(reviews)
      .set({ ...patch, last_modified: sql`now()` })
      .where(eq(reviews.id, id))
      .returning();
    if (editor) await writeReviewRevision(tx, id, pickContent(row), editor);
    const review = (await selectReview(id, tx))!;
    // Decided here, on the locked review, and sent after commit (BS#2864): notice 1 to a linked author someone
    // else edited; notice 3 to the music directors when the FCC line changed on a review still on some sleeve.
    const toAuthor = revises && current.author_user_id !== null && current.author_user_id !== actor.id;
    const copies = fccChanged ? await printedCopies(tx, id, patch.fcc ?? null) : [];
    const names = toAuthor || copies.length > 0 ? await recordNames(tx, current) : undefined;
    const authorNotice: AuthorNotice | undefined =
      names && toAuthor
        ? { ...names, reviewId: id, authorUserId: current.author_user_id!, name: editor!.name }
        : undefined;
    const fccNotice: FccChangeNotice | undefined =
      names && copies.length > 0
        ? { ...names, reviewId: id, editor: editor!.name, editorUserId: editor!.userId, fcc: patch.fcc ?? null, copies }
        : undefined;
    return { outcome: 'updated' as const, review, authorNotice, fccNotice };
  });

/**
 * Submit's two writes, for a caller that already holds the review locked: `status` `submitted`, `submitted_at` and
 * `last_modified` stamped, and revision 1 written, attributed to the review's own `author` and `author_user_id`.
 */
export const writeSubmission = async (
  tx: Tx & Pick<typeof db, 'update'>,
  row: RevisionContent & Pick<Review, 'id' | 'author' | 'author_user_id'>
) => {
  await tx
    .update(reviews)
    .set({ status: 'submitted', submitted_at: sql`now()`, last_modified: sql`now()` })
    .where(eq(reviews.id, row.id));
  await writeReviewRevision(tx, row.id, pickContent(row), { name: row.author, userId: row.author_user_id });
};

/**
 * Submits a draft: `submitted`, `submitted_at` stamped, and revision 1 written in the same transaction (a
 * draft has no history; it starts here), `edited_by` the author's snapshot. It never writes the intake item,
 * in any state, so a review submitted for a filed item is an ordinary submitted review. Whoever may edit the
 * review may submit it (`editOutcome`); a typed review needs text. The response is read back through
 * `selectReview` after both writes. It also returns the item as this submit saw it (`notice`, BS#2806: read after
 * the locks) for the notice the caller sends after commit; none for a library-release or music-director-recorded review.
 */
export const submitReview = async (id: number, actor: ReviewsActor) =>
  db.transaction(async (tx) => {
    if (!(await lockReviewAfterItem(tx, id, 'share'))) return { outcome: 'not_found' as const };
    const current = (await selectReview(id, tx))!;
    const decision = editOutcome(current, actor);
    if (decision !== 'allowed') return { outcome: decision };
    if (current.status !== 'draft') return { outcome: 'not_draft' as const };
    if (current.medium === 'typed' && current.review === null) return { outcome: 'text_required' as const };
    await writeSubmission(tx, current);
    // A review a music director recorded notifies nobody; a library-release review has no item.
    const notice =
      current.intake_item_id !== null && current.recorded_by_user_id === null
        ? await readReviewNotice(tx, current.intake_item_id, current)
        : undefined;
    return { outcome: 'submitted' as const, review: (await selectReview(id, tx))!, ...(notice && { notice }) };
  });

/** The print half of `in_use`, as the same fragment `selectReview` and the lists use. */
const isLatestPrint = async (tx: Pick<typeof db, 'execute'>, reviewId: number) => {
  const [row] = await tx.execute<{ in_use: boolean }>(
    sql`SELECT ${latestPrintOfCopy(sql`${reviewId}::int`)} AS in_use`
  );
  return row.in_use;
};

/**
 * Deletes a review (its revisions go with it). A review is IN USE when an item accepts it or it is the newest
 * print of a copy; an author without `reviews: manage` may not delete one (`in_use`). `reviews: manage` may,
 * except the accepted review of a filed or finalized item, whether or not the item carries a citation
 * (`accepted_review`, epic decision 40): a filed release must keep the review chosen for its cover. A review
 * can be accepted by several items, so every accepting item is judged, and when none refuses, one UPDATE
 * (`RELEASE_ACCEPTED_REVIEW`) runs before the delete and takes it off all of them. Locks:
 * `lockReviewAfterItem` with `acceptingItems`, then the accepting items are read again `FOR UPDATE` in
 * ascending id order under the review's lock, so the rows the refusal is judged on are locked: an accept that
 * committed in between is still judged, and a filing cannot change one of them before the UPDATE.
 */
export const deleteReview = async (id: number, actor: ReviewsActor) =>
  db.transaction(async (tx) => {
    if (!(await lockReviewAfterItem(tx, id, 'update', { acceptingItems: true }))) {
      return { outcome: 'not_found' as const };
    }
    const decision = editOutcome((await selectReview(id, tx))!, actor);
    if (decision !== 'allowed') return { outcome: decision };
    const accepting = await tx
      .select({ id: intake_items.id, state: intake_items.state })
      .from(intake_items)
      .where(eq(intake_items.accepted_review_id, id))
      .orderBy(intake_items.id)
      .for('update');
    if (actor.manage) {
      if (accepting.some((item) => FILED_STATES.includes(item.state))) return { outcome: 'accepted_review' as const };
    } else if (accepting.length > 0 || (await isLatestPrint(tx, id))) {
      return { outcome: 'in_use' as const };
    }
    if (accepting.length > 0) {
      await tx.update(intake_items).set(RELEASE_ACCEPTED_REVIEW).where(eq(intake_items.accepted_review_id, id));
    }
    await tx.delete(reviews).where(eq(reviews.id, id));
    return { outcome: 'deleted' as const };
  });

/** Mirror of the contract's `Reviewer` (`wxyc-shared/api.yaml`): an account a music director can ask to review. `name` is a real name (the staff name). */
export type ReviewerResponse = { id: string; name: string };

/**
 * `GET /reviews/reviewers` (BS#3058): accounts whose membership roles grant `reviews: write` (`canBeAskedToReview`, the rule
 * `/intake` applies to `dj_id`, which leaves out service accounts such as the auto-DJ and the uptime canary), less any account whose ban is in force (`isBanInForce`: a lapsed ban counts as lifted, though
 * better-auth clears `auth_user.banned` only at the next sign-in), named by the staff name and sorted by it case-insensitively.
 * `name` is a real name: it goes in the response only.
 */
export const listReviewers = async (): Promise<ReviewerResponse[]> => {
  const name = staffNameSql(user);
  const rows = await db
    .select({
      id: user.id,
      name,
      role: member.role,
      username: user.username,
      email: user.email,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .orderBy(sql`lower(${name})`, user.id);
  const reviewers = new Map<string, ReviewerResponse>();
  for (const { id, name: staffName, role, username, email, banned, banExpires } of rows) {
    if (canBeAskedToReview({ roles: [role], username, email }) && !isBanInForce({ banned, banExpires }))
      reviewers.set(id, { id, name: staffName });
  }
  return [...reviewers.values()];
};
