import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * BS#2476: `card` must reach `AlbumSearchResultRow` on every path that
 * produces one, sourced from the same row as `rotation_bin`.
 *
 * These tests pin the two MAPPERS (`toAlbumSearchResultRow`,
 * `taggedRowToAlbumSearchResultRow`) — see `library-search.artist-id.test.ts`
 * for why `db.execute` fixtures, not the SELECT itself, are what these assert
 * against. Integration coverage against real SQL (including the
 * CURRENT_DATE-filtered kill semantics) lives in
 * `tests/integration/library-query.spec.js`.
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
  q: 'autechre',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

function primaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7100,
    add_date: '2024-01-15',
    album_title: 'Confield',
    artist_name: 'Autechre',
    code_letters: 'AU',
    code_number: 3,
    code_artist_number: 1,
    format_name: 'CD',
    genre_name: 'Electronic',
    label: 'Warp',
    label_id: 10,
    rotation_bin: null,
    card_id: null,
    card_number: null,
    card_name: null,
    plays: 5,
    on_streaming: true,
    album_artist: null,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    last_discogs_recheck_at: null,
    artist_id: 501,
    ...overrides,
  };
}

describe('searchLibrary: card on AlbumSearchResultRow (BS#2476)', () => {
  beforeEach(() => {
    db.execute.mockReset();
    mockRunCatalogTrackSearchCascade.mockReset();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  it('raw-row mapper (toAlbumSearchResultRow): active row carries card', async () => {
    db.execute
      .mockResolvedValueOnce([primaryRow({ rotation_bin: 'H', card_id: 42, card_number: 3, card_name: 'Heavy 3' })])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].card).toEqual({ id: 42, bin: 'H', number: 3, name: 'Heavy 3' });
  });

  it('raw-row mapper: not-in-rotation row (rotation_bin null) carries no card', async () => {
    db.execute.mockResolvedValueOnce([primaryRow()]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].card).toBeNull();
  });

  it('raw-row mapper: rotation without a card assigned carries no card', async () => {
    db.execute.mockResolvedValueOnce([primaryRow({ rotation_bin: 'M' })]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].rotation_bin).toBe('M');
    expect(results[0].card).toBeNull();
  });

  it('tagged-row mapper (track-title cascade): active row carries card', async () => {
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([
      {
        id: 314,
        add_date: '2024-03-01',
        album_title: 'DOGA',
        artist_name: 'Juana Molina',
        code_letters: 'JU',
        code_number: 1,
        code_artist_number: 4,
        format_name: 'CD',
        genre_name: 'Rock',
        label: 'Sonamos',
        label_id: null,
        rotation_bin: 'L',
        card_id: 7,
        card_number: 2,
        card_name: null,
        plays: 12,
        on_streaming: true,
        album_artist: null,
        artist_id: 4200,
      },
    ]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].card).toEqual({ id: 7, bin: 'L', number: 2, name: null });
  });
});
