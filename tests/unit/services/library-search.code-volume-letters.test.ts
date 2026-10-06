import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * BS#2886 (epic BS#2828): `code_volume_letters` must reach `AlbumSearchResultRow` on both tiers of
 * `GET /library/query` -- the SQL tier (`toAlbumSearchResultRow`, over `CATALOG_ROW_PROJECTION`) and the
 * track-title cascade tier (`taggedRowToAlbumSearchResultRow`). Both copy `code_artist_number` field by field,
 * so adding the column to the view alone does not reach the wire (BS#2827 shipped `code_volume_letters` the same
 * way and `/library/query` still dropped it).
 *
 * Like `library-search.artist-id.test.ts`, these pin the mappers, not the SQL: `db.execute` is a bare mock. The
 * projections are covered by the shared-projection `satisfies` guards and the integration suite.
 */

const mockRunCatalogTrackSearchCascade = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

jest.mock('../../../apps/backend/services/library.service', () => ({
  runCatalogTrackSearchCascade: mockRunCatalogTrackSearchCascade,
}));

type SpanLike = { setAttribute: jest.Mock; setAttributes: jest.Mock };
type SpanOpts = { name: string; op: string; attributes?: Record<string, unknown> };
const spanInstance: SpanLike = { setAttribute: jest.fn(), setAttributes: jest.fn() };
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance)),
  getActiveSpan: () => spanInstance,
}));

import { searchLibrary } from '../../../apps/backend/services/library-search.service';
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';

const PARAMS = {
  q: 'soundtrack',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

const slotRow = (code_volume_letters: string | null) => ({
  id: 9200,
  add_date: '2024-01-15',
  album_title: 'Sample Soundtrack',
  artist_name: 'Various Artists',
  artist_id: 1087,
  code_letters: 'V/A',
  code_number: 3,
  code_artist_number: 3,
  code_volume_letters,
  format_name: 'CD',
  genre_name: 'Soundtracks',
  label: 'Sonamos',
  label_id: null,
  rotation_bin: null,
  plays: 5,
  on_streaming: true,
  album_artist: null,
  discogs_unavailable: false,
  discogs_unavailable_note: null,
  last_discogs_recheck_at: null,
});

describe('searchLibrary: code_volume_letters on AlbumSearchResultRow (BS#2886)', () => {
  beforeEach(() => {
    db.execute.mockReset();
    mockRunCatalogTrackSearchCascade.mockReset();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  it.each([
    ['a lettered volume', 'B'],
    ['an unlettered release', null],
  ])('SQL tier: %s carries code_volume_letters %p', async (_label, letter) => {
    db.execute.mockResolvedValueOnce([slotRow(letter)]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('code_volume_letters', letter);
  });

  it.each([
    ['a lettered volume', 'B'],
    ['an unlettered release', null],
  ])('track-cascade tier: %s carries code_volume_letters %p', async (_label, letter) => {
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([slotRow(letter)]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('code_volume_letters', letter);
  });
});
