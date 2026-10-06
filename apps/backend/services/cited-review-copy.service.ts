import { and, asc, eq, getTableColumns, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import { db, intake_items, review_prints, review_revisions, reviews } from '@wxyc/database';

type Tx = Pick<typeof db, 'select' | 'update' | 'execute'>;

/**
 * The records that took their cover review from release `albumId`, locked `FOR UPDATE` in
 * ascending `id` order in one statement: items whose accepted review belongs to the release and
 * whose own `album_id` is a different release or NULL (not yet filed). The review test is a
 * subquery so the statement has one table in its `FROM` and a plain `.for('update')` works;
 * drizzle's `{ of }` renders a schema-qualified `FOR UPDATE OF` that Postgres rejects.
 */
export const selectCitingItems = (tx: Pick<typeof db, 'select'>, albumId: number) =>
  tx
    .select({
      id: intake_items.id,
      album_id: intake_items.album_id,
      accepted_review_id: intake_items.accepted_review_id,
    })
    .from(intake_items)
    .where(
      and(
        sql`${intake_items.accepted_review_id} IN (SELECT ${reviews.id} FROM ${reviews} WHERE ${reviews.album_id} = ${albumId})`,
        sql`${intake_items.album_id} IS DISTINCT FROM ${albumId}`
      )
    )
    .orderBy(asc(intake_items.id))
    .for('update');

/** A table's column names less the ones a row copy sets itself, built from the table so a column added later is copied. */
const copiedColumns = (table: PgTable, omit: string[]) =>
  sql.join(
    Object.entries(getTableColumns(table))
      .filter(([key]) => !omit.includes(key))
      .map(([, column]) => sql.identifier(column.name)),
    sql`, `
  );

/**
 * Before a release is deleted, gives every record that took its cover review from it (BS#2875) its
 * own complete copy: the review row, every `review_revisions` row with its number, editor and time
 * unchanged, the record's `accepted_review_id` pointed at the copy, and the record's print log moved
 * onto it. The copy is a row copy, not an edit, so it never goes through `writeReviewRevision`
 * (which would renumber and restamp). Runs inside `deleteAlbumFromDB`'s transaction, after it has
 * locked the release's items (so `selectCitingItems` waits on nothing); items are locked before
 * reviews, the order `lockReviewAfterItem`'s callers (`deleteReview`, print, accept) use, and the originals are held
 * `FOR SHARE` so no `PATCH /reviews/{id}` (which locks its review `FOR UPDATE`) lands between the
 * review's copy and its history's. Names (`reviews.author`, `review_revisions.edited_by`) are
 * copied by the database and never read here.
 */
export const copyCitedCoverReviews = async (tx: Tx, albumId: number) => {
  const items = await selectCitingItems(tx, albumId);
  if (items.length === 0) return;

  const reviewIds = [...new Set(items.map((item) => item.accepted_review_id!))];
  await tx
    .select({ id: reviews.id })
    .from(reviews)
    .where(inArray(reviews.id, reviewIds))
    .orderBy(asc(reviews.id))
    .for('share');

  const reviewColumns = copiedColumns(reviews, ['id', 'intake_item_id', 'album_id']);
  const revisionColumns = copiedColumns(review_revisions, ['id', 'review_id']);
  // A table interpolated into `sql` renders without its alias, so each FROM/JOIN names it explicitly.
  const original = alias(review_revisions, 'original_revision');
  const copied = alias(review_revisions, 'copied_revision');

  for (const item of items) {
    const reviewId = item.accepted_review_id!;
    const [copy] = await tx.execute<{ id: number }>(sql`
      INSERT INTO ${reviews} (intake_item_id, album_id, ${reviewColumns})
      SELECT ${item.id}::integer, ${item.album_id}::integer, ${reviewColumns} FROM ${reviews} WHERE ${reviews.id} = ${reviewId}
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO ${review_revisions} (review_id, ${revisionColumns})
      SELECT ${copy.id}::integer, ${revisionColumns} FROM ${review_revisions} WHERE ${review_revisions.review_id} = ${reviewId}`);
    await tx.update(intake_items).set({ accepted_review_id: copy.id }).where(eq(intake_items.id, item.id));

    // The record's own rows, plus the release-level rows of the release it was filed as.
    const own = eq(review_prints.intake_item_id, item.id);
    const owned =
      item.album_id === null
        ? own
        : or(own, and(isNull(review_prints.intake_item_id), eq(review_prints.album_id, item.album_id)));
    await tx
      .update(review_prints)
      .set({
        review_id: copy.id,
        revision_id: sql`(SELECT ${copied.id} FROM ${review_revisions} AS copied_revision JOIN ${review_revisions} AS original_revision ON ${original.revision} = ${copied.revision}
          WHERE ${copied.review_id} = ${copy.id} AND ${original.id} = ${review_prints.revision_id})`,
      })
      .where(and(eq(review_prints.review_id, reviewId), owned));
  }
};
