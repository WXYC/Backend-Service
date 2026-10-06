import { db } from '../../mocks/database.mock';
import { PARAMS, libraryRow, useSearchLibraryScaffold } from './library-search.scaffold';
import { searchLibrary } from '../../../apps/backend/services/library-search.service';

/**
 * BS#2639: `genre_id` must reach `AlbumSearchResultRow` so a search result can link to the shelf it actually
 * names. Per-tier carrying is pinned by the table in `library-search.mapper-fields.test.ts`; what stays here is the
 * defect it was added for.
 *
 * `artists` rows are not one band each. Artist 431 is two unrelated acts sharing a name -- a hip-hop act filed
 * `IS 1` under Hiphop (genre 6) and a rock band filed `IS 13` under Rock (genre 11) -- and
 * `genre_artist_crossreference` is unique on `(artist_id, genre_id)`, so the pair, not the artist id, identifies a
 * card (BS#2637).
 */

/** The hip-hop Isis: artist 431, filed `IS 1` under Hiphop (genre 6). */
const hiphopIsis = (overrides: Record<string, unknown> = {}) =>
  libraryRow({
    album_title: 'Prelude',
    artist_name: 'Isis',
    artist_id: 431,
    code_letters: 'IS',
    code_number: 1,
    code_artist_number: 1,
    genre_name: 'Hiphop',
    genre_id: 6,
    ...overrides,
  });

/** The rock Isis: the SAME artist row, filed `IS 13` under Rock (genre 11). */
const rockIsis = () =>
  hiphopIsis({
    id: 7200,
    album_title: 'Oceanic',
    code_number: 13,
    code_artist_number: 13,
    genre_name: 'Rock',
    genre_id: 11,
  });

describe('searchLibrary: genre_id on AlbumSearchResultRow (BS#2639)', () => {
  useSearchLibraryScaffold();

  it('two shelves of one artist row carry their own distinct genre_id', async () => {
    db.execute.mockResolvedValueOnce([hiphopIsis(), rockIsis()]).mockResolvedValueOnce([{ total: 2 }]);

    const { results } = await searchLibrary({ ...PARAMS, q: 'isis' });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.artist_id)).toEqual([431, 431]);
    expect(results.map((r) => r.genre_id)).toEqual([6, 11]);
    // The call numbers the rows display are the crossreference rows those genre ids key.
    expect(results.map((r) => r.code_artist_number)).toEqual([1, 13]);
  });
});
