import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * `artwork_url` must reach `AlbumSearchResultRow` on every path that produces
 * one. `GET /library/` has carried the column since the artwork cache-through
 * landed; `GET /library/query` never projected it, so the catalog UI that reads
 * this endpoint had no album art to render and fell back to a filing-code
 * placeholder on every row.
 *
 * Same division of labour as `library-search.artist-id.test.ts`: these tests
 * pin the two MAPPERS (`toAlbumSearchResultRow`,
 * `taggedRowToAlbumSearchResultRow`), not the SELECTs. `db.execute` is a bare
 * mock that ignores its argument and every fixture supplies `artwork_url` by
 * hand, so deleting the column from the projections leaves this file green.
 * Coverage of the projection itself is the integration suite's job, against
 * real SQL: `tests/integration/library-query.spec.js` asserts the key's
 * presence on a CTA cascade hit.
 *
 * `null` is the load-bearing case, not an edge case: it is what an un-enriched
 * row carries, and a mapper that dropped the key entirely would serialize the
 * same way a mapper that carried `null` does (`JSON.stringify` omits
 * `undefined`). The assertions therefore check the key, never the value alone.
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
  q: 'juana molina',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

const ARTWORK = 'https://i.discogs.com/doga.jpg';

function primaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7100,
    add_date: '2024-01-15',
    album_title: 'DOGA',
    artist_name: 'Juana Molina',
    code_letters: 'JU',
    code_number: 1,
    code_artist_number: 4,
    format_name: 'CD',
    genre_name: 'Rock',
    label: 'Sonamos',
    label_id: 10,
    rotation_bin: null,
    plays: 5,
    on_streaming: true,
    album_artist: null,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    last_discogs_recheck_at: null,
    artist_id: 501,
    artwork_url: ARTWORK,
    ...overrides,
  };
}

describe('searchLibrary: artwork_url on AlbumSearchResultRow', () => {
  const originalFlag = process.env.CATALOG_SEARCH_ALIAS_ENABLED;

  beforeEach(() => {
    db.execute.mockReset();
    mockRunCatalogTrackSearchCascade.mockReset();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    else process.env.CATALOG_SEARCH_ALIAS_ENABLED = originalFlag;
    resetCatalogSearchAliasConfig();
  });

  it('alias off: direct-hit row carries artwork_url', async () => {
    db.execute.mockResolvedValueOnce([primaryRow()]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artwork_url).toBe(ARTWORK);
  });

  it('un-enriched row carries the key with a null value, not an absent key', async () => {
    db.execute.mockResolvedValueOnce([primaryRow({ artwork_url: null })]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('artwork_url', null);
  });

  it('alias on: alias-only hit (branch B) carries artwork_url', async () => {
    process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
    resetCatalogSearchAliasConfig();
    db.execute
      .mockResolvedValueOnce([
        primaryRow({
          alias_max_sim: 0.85,
          alias_matched_variant: 'Juana Molena',
          alias_matched_source: 'discogs_name_variation',
        }),
      ])
      .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artwork_url).toBe(ARTWORK);
  });

  it('track-title cascade hit (TaggedLibraryViewEntry mapper) carries artwork_url', async () => {
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([
      {
        id: 314,
        add_date: '2024-03-01',
        album_title: 'On Your Own Love Again',
        artist_name: 'Jessica Pratt',
        code_letters: 'PR',
        code_number: 2,
        code_artist_number: 7,
        format_name: 'Vinyl',
        genre_name: 'Rock',
        label: 'Drag City',
        label_id: null,
        rotation_bin: null,
        plays: 12,
        on_streaming: true,
        album_artist: null,
        artist_id: 4200,
        artwork_url: 'https://i.discogs.com/on-your-own-love-again.jpg',
      },
    ]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artwork_url).toBe('https://i.discogs.com/on-your-own-love-again.jpg');
  });

  it('cascade hit with no enriched artwork carries the key with a null value', async () => {
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([
      {
        id: 315,
        add_date: '2024-03-01',
        album_title: 'Edits',
        artist_name: 'Chuquimamani-Condori',
        code_letters: 'CH',
        code_number: 1,
        code_artist_number: 9,
        format_name: 'CD',
        genre_name: 'Electronic',
        label: 'self-released',
        label_id: null,
        rotation_bin: null,
        plays: 3,
        on_streaming: false,
        album_artist: null,
        artist_id: 4300,
        artwork_url: null,
      },
    ]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('artwork_url', null);
  });
});
