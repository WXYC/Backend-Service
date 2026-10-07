import { and, asc, eq, or, sql, type InferSelectModel } from 'drizzle-orm';
import { artists, db, fcc_notes, intake_items, library } from '@wxyc/database';
import type { RecordSubject } from '../utils/record-subject.js';
import type { ReviewsActor } from '../utils/review-grants.js';
import { withLockedRecordSubject } from './intake.service.js';
import { readAccountName } from './reviews.service.js';

/**
 * FCC notes on the record (BS#2862, slice 13c of BS#2791): any DJ reports a note against a library release or an
 * intake item, and every DJ sees it at once. A music director confirms or removes it (BS#2863), and only a confirmed
 * note prints on the slip.
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
 * rule. A note of a filed or finalized item is stamped with the item's release at once. `withLockedRecordSubject` retries an
 * item filed between the unlocked read and the lock; a subject it does not find is `unknown_subject`. `no_account` is a caller with no name
 * to snapshot: nothing is written. `notice` is what BS#2863's email needs, for the caller to send after the commit.
 */
export const createFccNote = async (
  subject: RecordSubject,
  fields: { track: string; note: string },
  actor: ReviewsActor
) => {
  const result = await withLockedRecordSubject(subject, 'share', async (tx, locked) => {
    const reported_by = await readAccountName(tx, actor.id);
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
  return result?.value ?? { outcome: 'unknown_subject' as const };
};

export type FccNoteStatus = (typeof fcc_notes.status.enumValues)[number];

const oldestFirst = [asc(fcc_notes.reported_at), asc(fcc_notes.id)];

/** The notes of one release (including those stamped at filing) or one item, oldest first; both statuses unless `status` is sent. */
export const listFccNotes = (filter: RecordSubject & { status?: FccNoteStatus }): Promise<FccNoteResponse[]> =>
  selectFccNotes(db)
    .where(
      and(
        filter.intake_item_id !== undefined
          ? eq(fcc_notes.intake_item_id, filter.intake_item_id)
          : eq(fcc_notes.album_id, filter.album_id),
        filter.status && eq(fcc_notes.status, filter.status)
      )
    )
    .orderBy(...oldestFirst);

/** The music directors' waiting list: every unconfirmed note at the station, oldest first, in one statement. */
export const listReportedFccNotes = (): Promise<FccNoteResponse[]> =>
  selectFccNotes(db)
    .where(eq(fcc_notes.status, 'reported'))
    .orderBy(...oldestFirst);

/**
 * Confirms a note: one `UPDATE … WHERE id AND status = 'reported' RETURNING`, stamping the caller's account name
 * (`snapshotAuthor`, as the create does; never `real_name`) and the time, and answering the row it returned (with the
 * record's artist and album, read in the same transaction after it). Neither this nor `deleteFccNote` reads an item or
 * a review, so each takes the note's own row lock and nothing else. A note already confirmed matches no row and is
 * answered unchanged, the first confirmer's stamp kept. `no_account` is a caller with no name to snapshot: nothing is written.
 */
export const confirmFccNote = async (id: number, actor: Pick<ReviewsActor, 'id'>) => {
  const confirmed_by = await readAccountName(db, actor.id);
  if (confirmed_by === null) return { outcome: 'no_account' as const };
  return db.transaction(async (tx) => {
    const [confirmed] = await tx
      .update(fcc_notes)
      .set({ status: 'confirmed', confirmed_by, confirmed_at: sql`now()` })
      .where(and(eq(fcc_notes.id, id), eq(fcc_notes.status, 'reported')))
      .returning();
    // The UPDATE holds the note's row lock until the commit, so a delete cannot land before this read: when the UPDATE
    // matched, the note it answers is the row it wrote, with the record's artist and album read beside it.
    const [read] = await selectFccNotes(tx).where(eq(fcc_notes.id, id));
    if (confirmed && read) return { outcome: 'confirmed' as const, note: { ...read, ...confirmed } };
    return read ? { outcome: 'confirmed' as const, note: read } : { outcome: 'not_found' as const };
  });
};

/**
 * Deletes a note. A caller with `reviews: manage` may delete any; anyone else only their own note while it is still
 * `reported`, a condition in the `DELETE`'s `WHERE` and not a prior read, so a reporter's delete racing a confirm either
 * removes a reported note or matches nothing, and never removes a confirmed one. Zero rows is then read once to tell a
 * note that is not there (`not_found`) from one the caller may not delete (`forbidden`).
 */
export const deleteFccNote = async (id: number, actor: ReviewsActor) => {
  const deleted = await db
    .delete(fcc_notes)
    .where(
      and(
        eq(fcc_notes.id, id),
        actor.manage ? undefined : and(eq(fcc_notes.reported_by_user_id, actor.id), eq(fcc_notes.status, 'reported'))
      )
    )
    .returning({ id: fcc_notes.id });
  if (deleted.length > 0) return { outcome: 'deleted' as const };
  const [exists] = await db.select({ id: fcc_notes.id }).from(fcc_notes).where(eq(fcc_notes.id, id));
  return { outcome: exists ? ('forbidden' as const) : ('not_found' as const) };
};

/**
 * The confirmed notes of a record, for its slip: those of the item (`intake_item_id`) or of its release (`album_id`),
 * whichever the target carries, oldest first as the lists are. Reported notes never print.
 */
export const confirmedFccNotesOf = async (
  tx: Pick<typeof db, 'select'>,
  target: { intake_item_id: number | null; album_id: number | null }
): Promise<{ track: string; note: string }[]> => {
  const subjects = [
    target.intake_item_id === null ? undefined : eq(fcc_notes.intake_item_id, target.intake_item_id),
    target.album_id === null ? undefined : eq(fcc_notes.album_id, target.album_id),
  ].filter((subject) => subject !== undefined);
  if (subjects.length === 0) return [];
  return tx
    .select({ track: fcc_notes.track, note: fcc_notes.note })
    .from(fcc_notes)
    .where(and(eq(fcc_notes.status, 'confirmed'), or(...subjects)))
    .orderBy(...oldestFirst);
};
