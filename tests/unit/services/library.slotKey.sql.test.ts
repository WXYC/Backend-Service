/**
 * Pins `librarySlotKey`'s JS volume-letter fold and
 * `librarySlotVolumeLetterMatchSql`'s SQL fold (the predicate
 * `findLibrarySlotOccupant` composes) together against a case-mixed
 * fixture, so a regression in either one -- a bare `=`, a dropped
 * `UPPER`/`COALESCE` -- goes red here instead of only surfacing as a
 * wrongly "free" shelf slot in production.
 */
import { library } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';
import { librarySlotKey, librarySlotVolumeLetterMatchSql } from '../../../apps/backend/services/library.service';

describe('shelf slot key: JS fold and SQL fold pinned together', () => {
  it('librarySlotKey folds the volume letter to upper case', () => {
    expect(librarySlotKey({ artist_id: 1, genre_id: 2, code_number: 3, code_volume_letters: 'd' })).toBe('1/2/3/D');
    expect(librarySlotKey({ artist_id: 1, genre_id: 2, code_number: 3, code_volume_letters: 'D' })).toBe('1/2/3/D');
    expect(librarySlotKey({ artist_id: 1, genre_id: 2, code_number: 3, code_volume_letters: null })).toBe('1/2/3/');
  });

  it('librarySlotVolumeLetterMatchSql compiles to UPPER(COALESCE(...)) on both sides', () => {
    const rendered = renderSql(librarySlotVolumeLetterMatchSql(library.code_volume_letters, 'd'));
    expect(rendered).toBe(`UPPER(COALESCE(library.code_volume_letters, '')) = UPPER(COALESCE(d, ''))`);
  });

  it('agree on a case-mixed fixture: a stored `d` and an incoming `D` are the same slot on both sides', () => {
    const stored = 'd';
    const incoming = 'D';

    expect(librarySlotKey({ artist_id: 5, genre_id: 6, code_number: 7, code_volume_letters: stored })).toBe(
      librarySlotKey({ artist_id: 5, genre_id: 6, code_number: 7, code_volume_letters: incoming })
    );

    // A regression to a bare `=` would still compile -- it just wouldn't
    // fold case -- so pin the predicate text itself, not merely that it
    // runs.
    const rendered = renderSql(librarySlotVolumeLetterMatchSql(library.code_volume_letters, incoming));
    expect(rendered).toBe(`UPPER(COALESCE(library.code_volume_letters, '')) = UPPER(COALESCE(D, ''))`);
  });
});
