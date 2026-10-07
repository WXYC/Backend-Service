import { and, desc, eq, sql } from 'drizzle-orm';
import {
  artists,
  db,
  intake_items,
  library,
  review_prints,
  review_revisions,
  reviews,
  type Review,
} from '@wxyc/database';
import type { ReviewsActor } from '../utils/review-grants.js';
import { confirmedFccNotesOf } from './fcc-notes.service.js';
import { lockRecordSubject } from './intake.service.js';
import { lockReleaseRow } from '../utils/release-row-lock.js';
import { reviewInReleaseList, writeFirstRevisionIfMissing } from './reviews.service.js';

/**
 * The print log and the slip (BS#2804). Its own module because `reviews.service` imports `intake.service`, and the print
 * needs both: the item lock from one and the first-revision backfill from the other.
 */

/** Mirror of the contract's `IntakeSlip`; private because Backend-Service stays on `@wxyc/shared` 5.x. */
export type IntakeSlip = {
  artist_name: string;
  album_title: string;
  record_label: string | null;
  buzzwords: string | null;
  artist_blurb: string | null;
  review: string | null;
  author: string | null;
  submitted_at: Date | null;
  recommended_tracks: string | null;
  fcc: string | null;
  revision_id: number;
  /** The record's confirmed FCC notes (its item's and its release's), oldest first; reported ones never print. */
  fcc_notes: { track: string; note: string }[];
};

/** What a slip names: the record's own identity, which a cited item keeps even though its review is the cited release's. */
export type SlipRecord = Pick<IntakeSlip, 'artist_name' | 'album_title' | 'record_label'>;

/**
 * Appends one `review_prints` row and builds the slip, for a caller that holds the review locked (after the item, after
 * the library row of a filed one, as `printIntakeItem` does). The review's current revision is the one printed; a
 * submitted review with no history first gets revision 1 through `writeFirstRevisionIfMissing`; the confirmed FCC notes of
 * `target` are read last, inside the caller's transaction after its locks. `target` is the row's
 * `intake_item_id` and `album_id`, either of which may be null. The release print (BS#2865) writes the same log through it.
 */
export const printSlip = async (
  tx: Pick<typeof db, 'select' | 'insert'>,
  target: { intake_item_id: number | null; album_id: number | null },
  record: SlipRecord,
  review: Review,
  printedBy: string
): Promise<IntakeSlip> => {
  await writeFirstRevisionIfMissing(tx, review);
  const [revision] = await tx
    .select()
    .from(review_revisions)
    .where(eq(review_revisions.review_id, review.id))
    .orderBy(desc(review_revisions.revision))
    .limit(1);
  // A submitted review always has one: submit writes revision 1 and the backfill above covers the rest.
  await tx
    .insert(review_prints)
    .values({ ...target, review_id: review.id, revision_id: revision!.id, printed_by: printedBy });
  return {
    artist_name: record.artist_name,
    album_title: record.album_title,
    record_label: record.record_label,
    buzzwords: revision!.buzzwords,
    artist_blurb: revision!.artist_blurb,
    review: revision!.review,
    author: review.author,
    submitted_at: review.submitted_at,
    recommended_tracks: revision!.recommended_tracks,
    fcc: revision!.fcc,
    revision_id: revision!.id,
    fcc_notes: await confirmedFccNotesOf(tx, target),
  };
};

/**
 * `POST /intake/{id}/print`: prints the item's accepted review, which must be typed (a handwritten one is already on the
 * sleeve), in one transaction. Locks in the order `DELETE /library/{id}` takes (BS#2928): through `lockRecordSubject` the
 * item's release `FOR KEY SHARE` when it is filed, then the item `FOR UPDATE`, then the accepted review `FOR UPDATE`, so a
 * print and an edit of one review serialize and the print records the revision current when it commits. Nothing is locked
 * against the author: a later edit succeeds. `lockRecordSubject` answers `undefined` for a missing item and for one filed
 * between its unlocked read and the lock, in which case this attempt wrote nothing and the transaction runs once more; a
 * second `undefined` is `not_found`. The item's `printed_by` and `printed_at` stay the latest print.
 */
export const printIntakeItem = async (id: number, actor: Pick<ReviewsActor, 'id'>) => {
  const attempt = () =>
    db.transaction(async (tx) => {
      const target = await lockRecordSubject(tx, { intake_item_id: id }, 'update');
      if (!target) return undefined;
      const [item] = await tx
        .select({
          artist_name: intake_items.artist_name,
          album_title: intake_items.album_title,
          record_label: intake_items.record_label,
          accepted_review_id: intake_items.accepted_review_id,
        })
        .from(intake_items)
        .where(eq(intake_items.id, id));
      const [review] =
        item.accepted_review_id === null
          ? []
          : await tx.select().from(reviews).where(eq(reviews.id, item.accepted_review_id)).for('update');
      if (!review || review.medium !== 'typed') return { outcome: 'not_reviewed' as const };
      const slip = await printSlip(
        tx,
        { intake_item_id: id, album_id: target.album_id ?? null },
        item,
        review,
        actor.id
      );
      await tx
        .update(intake_items)
        .set({ printed_by: actor.id, printed_at: sql`now()` })
        .where(eq(intake_items.id, id));
      return { outcome: 'printed' as const, slip };
    });
  return (await attempt()) ?? (await attempt()) ?? { outcome: 'not_found' as const };
};

/**
 * `POST /library/{id}/print` (BS#2865): prints a typed, submitted review in the release's list (`reviewInReleaseList`)
 * for a release that may have no intake item, in one transaction. Locks in `DELETE /library/{id}`'s order: the release
 * `FOR KEY SHARE` (the print row's foreign key would take it anyway, so after the review it would deadlock with a delete),
 * then the review `FOR UPDATE`. The row written has no item, so nothing on `intake_items` is written or locked and the log
 * is the only record; the membership check reads `intake_items` (the citing items of the release), unlocked. The slip's
 * artist is the release's displayed one (`alternate_artist_name`, else the artist's name). `not_found` is a missing release; `bad_review` is every other refusal, one answer for all of them.
 */
export const printReleaseReview = async (id: number, reviewId: number, actor: Pick<ReviewsActor, 'id'>) =>
  db.transaction(async (tx) => {
    if (!(await lockReleaseRow(tx, id))) return { outcome: 'not_found' as const };
    const [review] = await tx
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), reviewInReleaseList(id)))
      .for('update');
    if (!review || review.medium !== 'typed' || review.status !== 'submitted')
      return { outcome: 'bad_review' as const };
    const [record] = await tx
      .select({
        // The release's displayed artist: `alternate_artist_name || artist_name`, as filing hands it to enrichment
        // (`library-filing.service.ts`, `library.controller.ts`), so a compilation under a V/A bucket names its own artist.
        artist_name: sql<string>`coalesce(nullif(${library.alternate_artist_name}, ''), ${artists.artist_name})`,
        album_title: library.album_title,
        record_label: library.label,
      })
      .from(library)
      .innerJoin(artists, eq(artists.id, library.artist_id))
      .where(eq(library.id, id));
    return {
      outcome: 'printed' as const,
      slip: await printSlip(tx, { intake_item_id: null, album_id: id }, record, review, actor.id),
    };
  });
