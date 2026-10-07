import { asc, eq, sql, type InferSelectModel } from 'drizzle-orm';
import { artists, db, fcc_notes, intake_items, library, user } from '@wxyc/database';
import type { RecordSubject } from '../utils/record-subject.js';
import type { ReviewsActor } from '../utils/review-grants.js';
import { lockRecordSubject } from './intake.service.js';
import { snapshotAuthor } from './reviews.service.js';

/**
 * FCC notes on the record (BS#2862, slice 13c of BS#2791): any DJ reports a note against a library release or an
 * intake item, and every DJ sees it at once. Confirming and deleting are BS#2863.
 */

/**
 * Mirror of the contract's `FccNote` (`wxyc-shared/api.yaml`); private because Backend-Service stays on `@wxyc/shared`
 * 5.x. `reported_by` is a required string here, the column being NOT NULL (migration 0187). `artist_name` and
 * `album_title` are read at response time, never stored.
 */
export type FccNoteResponse = InferSelectModel<typeof fcc_notes> & { artist_name: string; album_title: string };

/**
 * The columns of every `FccNote` response (the create, the lists here, and BS#2863's confirm and waiting list). The
 * record's artist and title come from the library release when the note has an `album_id`, else from the intake item.
 */
export const fccNoteSelection = {
  id: fcc_notes.id,
  album_id: fcc_notes.album_id,
  intake_item_id: fcc_notes.intake_item_id,
  track: fcc_notes.track,
  note: fcc_notes.note,
  status: fcc_notes.status,
  reported_by: fcc_notes.reported_by,
  reported_by_user_id: fcc_notes.reported_by_user_id,
  reported_at: fcc_notes.reported_at,
  confirmed_by: fcc_notes.confirmed_by,
  confirmed_at: fcc_notes.confirmed_at,
  artist_name: sql<string>`coalesce(${artists.artist_name}, ${intake_items.artist_name})`,
  album_title: sql<string>`coalesce(${library.album_title}, ${intake_items.album_title})`,
};

/** Every `FccNote` read starts here: one statement with left joins, so a list is never a query per note. The caller adds `where` and `orderBy`. */
export const selectFccNotes = (handle: Pick<typeof db, 'select'>) =>
  handle
    .select(fccNoteSelection)
    .from(fcc_notes)
    .leftJoin(library, eq(library.id, fcc_notes.album_id))
    .leftJoin(artists, eq(artists.id, library.artist_id))
    .leftJoin(intake_items, eq(intake_items.id, fcc_notes.intake_item_id));

/**
 * Reports a note, in the order `DELETE /library/{id}` (BS#2928) takes its locks: `lockRecordSubject` locks the
 * library row `FOR KEY SHARE` (the existence check for a release) and then the item `FOR SHARE`. There is no hold
 * rule. A note of a filed or finalized item is stamped with the item's release at once. An item the lock does not
 * find may be one that was filed between the unlocked read and the lock, and inserting the note then would leave a
 * filed item's note with no release, so the transaction runs once more: filing is terminal, and the retry locks the
 * release first. A second miss is `unknown_subject`, as is a missing release. `no_account` is a caller with no name
 * to snapshot: nothing is written. `notice` is what BS#2863's email needs, for the caller to send after the commit.
 */
export const createFccNote = async (
  subject: RecordSubject,
  fields: { track: string; note: string },
  actor: ReviewsActor
) => {
  const attempt = () =>
    db.transaction(async (tx) => {
      const locked = await lockRecordSubject(tx, subject, 'share');
      if (!locked) return { outcome: 'unknown_subject' as const };
      const [account] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actor.id));
      const reported_by = snapshotAuthor(account?.name);
      if (reported_by === null) return { outcome: 'no_account' as const };
      const [{ id }] = await tx
        .insert(fcc_notes)
        .values({
          ...fields,
          album_id: locked.album_id,
          intake_item_id: subject.intake_item_id,
          status: 'reported',
          reported_by,
          reported_by_user_id: actor.id,
        })
        .returning({ id: fcc_notes.id });
      const [note] = await selectFccNotes(tx).where(eq(fcc_notes.id, id));
      return {
        outcome: 'created' as const,
        note,
        notice: { note, artist: note.artist_name, album: note.album_title, reporterUserId: actor.id },
      };
    });
  const first = await attempt();
  return first.outcome === 'unknown_subject' && subject.intake_item_id !== undefined ? attempt() : first;
};

/** The notes of one release (including those stamped at filing) or one item, both statuses, oldest first. */
export const listFccNotes = (filter: RecordSubject): Promise<FccNoteResponse[]> =>
  selectFccNotes(db)
    .where(
      filter.intake_item_id !== undefined
        ? eq(fcc_notes.intake_item_id, filter.intake_item_id)
        : eq(fcc_notes.album_id, filter.album_id)
    )
    .orderBy(asc(fcc_notes.reported_at), asc(fcc_notes.id));
