import { db } from '../../mocks/database.mock';
import { PARAMS, libraryRow, useSearchLibraryScaffold } from './library-search.scaffold';
import { searchLibrary } from '../../../apps/backend/services/library-search.service';

/**
 * BS#2227: `artist_id` reaching `AlbumSearchResultRow` on each tier is pinned by the table in
 * `library-search.mapper-fields.test.ts`. What stays here is the V/A case, which is about the value rather than
 * the mapper.
 *
 * Note the cascade's CTA arm does NOT read `library_artist_view` -- it joins `compilation_track_artist` /
 * `library` / `artists` itself. Since BS#2231 it projects the shared `LIBRARY_VIEW_PROJECTION_RAW`, so `artist_id`
 * reaches it by construction; what pins that is `library-cta-projection.test.ts`.
 */
describe('searchLibrary: artist_id on AlbumSearchResultRow (BS#2227)', () => {
  useSearchLibraryScaffold();

  it('V/A compilation hit returns the shared compilation artist id, not null', async () => {
    db.execute
      .mockResolvedValueOnce([
        libraryRow({
          id: 9200,
          artist_name: 'Various Artists',
          code_letters: 'V/A',
          album_title: 'Sample Various',
          artist_id: 1087,
        }),
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artist_id).toBe(1087);
  });
});
