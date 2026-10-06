import { db } from '../../mocks/database.mock';
import {
  ALIAS_HIT,
  PARAMS,
  libraryRow,
  mockRunCatalogTrackSearchCascade,
  useSearchLibraryScaffold,
} from './library-search.scaffold';
import { searchLibrary } from '../../../apps/backend/services/library-search.service';
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';

/**
 * Each column `GET /library/query` carries must reach `AlbumSearchResultRow` on every tier that produces one: the
 * SQL tier (`toAlbumSearchResultRow`), the alias-only branch of the SQL tier, and the track-title cascade tier
 * (`taggedRowToAlbumSearchResultRow`). Both mappers copy field by field, so adding a column to the view alone does
 * not reach the wire (BS#2227 artist_id, BS#2639 genre_id, BS#2835 code_comp_letter, BS#2827/BS#2886
 * code_volume_letters, BS#1895 discogs_unavailable, and the artwork_url omission all shipped that way).
 *
 * These pin the mappers, not the SQL: `db.execute` is a bare mock that ignores its argument and every fixture
 * supplies the column by hand, so deleting a projection entry leaves this file green. The projection is covered by
 * the `satisfies` guard on `CATALOG_ROW_PROJECTION_COLUMNS`, the view-coverage guard beside it, and
 * `tests/integration/library-query.spec.js`. `null` cases assert the key's presence, never the value alone:
 * `JSON.stringify` omits `undefined`, so a mapper that dropped the key would otherwise look like one carrying null.
 */

type FieldCase = { column: string; key: string; value: unknown };

const FIELD_CASES: FieldCase[] = [
  { column: 'artist_id', key: 'artist_id', value: 501 },
  { column: 'artist_id', key: 'artist_id', value: 1087 },
  { column: 'genre_id', key: 'genre_id', value: 6 },
  { column: 'code_comp_letter', key: 'code_comp_letter', value: 'M' },
  { column: 'code_comp_letter', key: 'code_comp_letter', value: null },
  { column: 'code_volume_letters', key: 'code_volume_letters', value: 'B' },
  { column: 'code_volume_letters', key: 'code_volume_letters', value: null },
  { column: 'artwork_url', key: 'artwork_url', value: 'https://i.discogs.com/doga.jpg' },
  { column: 'artwork_url', key: 'artwork_url', value: null },
  { column: 'discogs_unavailable', key: 'discogsUnavailable', value: true },
  { column: 'discogs_unavailable', key: 'discogsUnavailable', value: false },
  { column: 'discogs_unavailable_note', key: 'discogsUnavailableNote', value: 'Embargoed promo pressing' },
  { column: 'discogs_unavailable_note', key: 'discogsUnavailableNote', value: null },
  { column: 'last_discogs_recheck_at', key: 'lastDiscogsRecheckAt', value: '2026-07-20T04:00:00.000Z' },
];

const TIERS = [
  {
    tier: 'SQL tier',
    run: async (row: Record<string, unknown>) => {
      db.execute.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 1 }]);
      return searchLibrary(PARAMS);
    },
  },
  {
    tier: 'SQL tier, alias-only hit',
    run: async (row: Record<string, unknown>) => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      db.execute
        .mockResolvedValueOnce([{ ...row, ...ALIAS_HIT }])
        .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);
      return searchLibrary(PARAMS);
    },
  },
  {
    tier: 'track-cascade tier',
    run: async (row: Record<string, unknown>) => {
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
      mockRunCatalogTrackSearchCascade.mockResolvedValue([row]);
      return searchLibrary(PARAMS);
    },
  },
];

describe('searchLibrary: carried columns reach AlbumSearchResultRow', () => {
  useSearchLibraryScaffold();

  describe.each(TIERS)('$tier', ({ run }) => {
    it.each(FIELD_CASES)('$column = $value reaches $key', async ({ column, key, value }) => {
      const { results } = await run(libraryRow({ [column]: value }));

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty(key, value);
    });
  });
});
