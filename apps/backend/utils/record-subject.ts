import WxycError from './error.js';
import { parseInt4BodyId } from './query-params.js';

/**
 * What a record (a review, an FCC note) is about: an intake item or a library release, never both. Narrow with
 * `subject.intake_item_id !== undefined`.
 */
export type RecordSubject = { intake_item_id: number; album_id?: never } | { album_id: number; intake_item_id?: never };

/** Parses a request body's `intake_item_id` / `album_id`; a 400 unless exactly one is sent. */
export const parseRecordSubject = (body: Record<string, unknown>): RecordSubject => {
  const intake_item_id = parseInt4BodyId(body.intake_item_id, 'intake_item_id');
  const album_id = parseInt4BodyId(body.album_id, 'album_id');
  if (intake_item_id !== undefined && album_id === undefined) return { intake_item_id };
  if (album_id !== undefined && intake_item_id === undefined) return { album_id };
  throw new WxycError('Send exactly one of intake_item_id and album_id', 400);
};
