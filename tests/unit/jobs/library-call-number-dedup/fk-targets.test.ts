/**
 * `mergeSlot` re-points every `FK_TARGETS` entry in array order inside one
 * transaction, so the order is the order the merge locks rows in. Every route
 * that touches an intake item and its reviews locks the item row first and the
 * review second (PR #2857); a merge that reached `reviews` before
 * `intake_items` would take them the other way round and could deadlock with an
 * accept or a print of a filed item whose release is being merged.
 */
import { FK_TARGETS } from '../../../../jobs/library-call-number-dedup/merge';

const position = (table: string, column: string) =>
  FK_TARGETS.findIndex((target) => target.table === table && target.column === column);

describe('FK_TARGETS lock order', () => {
  it('ends with the intake item entries, then reviews, review_prints and fcc_notes', () => {
    expect(FK_TARGETS.slice(-5).map(({ table, column }) => `${table}.${column}`)).toEqual([
      'intake_items.album_id',
      'intake_items.cited_album_id',
      'reviews.album_id',
      'review_prints.album_id',
      'fcc_notes.album_id',
    ]);
  });

  it.each([
    ['intake_items', 'album_id'],
    ['intake_items', 'cited_album_id'],
  ])('re-points %s.%s before every table that references its reviews, prints or notes', (table, column) => {
    for (const [later, laterColumn] of [
      ['reviews', 'album_id'],
      ['review_prints', 'album_id'],
      ['fcc_notes', 'album_id'],
    ]) {
      expect(position(table, column)).toBeGreaterThanOrEqual(0);
      expect(position(table, column)).toBeLessThan(position(later, laterColumn));
    }
  });
});
