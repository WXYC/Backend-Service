import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * BS#2639: `genre_id` must reach `AlbumSearchResultRow` on every path that
 * produces one, so a search result can link to the shelf it actually names.
 *
 * `artists` rows are not one band each. Artist 431 is two unrelated acts
 * sharing a name -- a hip-hop act filed `IS 1` under Hiphop and a rock band
 * filed `IS 13` under Rock -- and `genre_artist_crossreference` is unique on
 * `(artist_id, genre_id)`, so the pair, not the artist id, is what identifies
 * a card. A row carrying only `genre_name` forces its consumer to fall back
 * to the lowest-`genre_id` collapse, which is how both Isises end up on one
 * card (BS#2637).
 *
 * Same coverage split as `library-search.artist-id.test.ts`, for the same
 * reason: these tests pin the two MAPPERS (`toAlbumSearchResultRow`,
 * `taggedRowToAlbumSearchResultRow`) -- that each carries `genre_id` from its
 * input row to its output. They CANNOT verify the SQL selects the column:
 * `db.execute` is a bare mock that ignores its argument and every fixture
 * below supplies `genre_id` by hand, so deleting the projection entry leaves
 * this file green. That half is `tests/integration/library-query.spec.js`,
 * which asserts `typeof hit.genre_id === 'number'` against real SQL.
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
  q: 'isis',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

/** The hip-hop Isis: artist 431, filed `IS 1` under Hiphop (genre 4). */
function hiphopIsis(overrides: Record<string, unknown> = {}) {
  return {
    id: 7100,
    add_date: '2024-01-15',
    album_title: 'Prelude',
    artist_name: 'Isis',
    code_letters: 'IS',
    code_number: 1,
    code_artist_number: 1,
    format_name: 'CD',
    genre_name: 'Hiphop',
    genre_id: 4,
    label: 'Ruffhouse',
    label_id: 10,
    rotation_bin: null,
    plays: 5,
    on_streaming: true,
    album_artist: null,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    last_discogs_recheck_at: null,
    artist_id: 431,
    ...overrides,
  };
}

/** The rock Isis: the SAME artist row, filed `IS 13` under Rock (genre 11). */
function rockIsis(overrides: Record<string, unknown> = {}) {
  return hiphopIsis({
    id: 7200,
    album_title: 'Oceanic',
    code_number: 13,
    code_artist_number: 13,
    genre_name: 'Rock',
    genre_id: 11,
    label: 'Ipecac',
    ...overrides,
  });
}

describe('searchLibrary: genre_id on AlbumSearchResultRow (BS#2639)', () => {
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

  it('alias off: direct-hit row carries genre_id', async () => {
    db.execute.mockResolvedValueOnce([hiphopIsis()]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].genre_id).toBe(4);
  });

  /**
   * The defect in one assertion. Both rows are artist 431, so `artist_id`
   * cannot tell them apart and neither can `code_letters`; only `genre_id`
   * separates `IS 1` from `IS 13`. A consumer that has just these two rows
   * must be able to link each to its own card.
   */
  it('two shelves of one artist row carry their own distinct genre_id', async () => {
    db.execute.mockResolvedValueOnce([hiphopIsis(), rockIsis()]).mockResolvedValueOnce([{ total: 2 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.artist_id)).toEqual([431, 431]);
    expect(results.map((r) => r.genre_id)).toEqual([4, 11]);
    // The call numbers the two rows display are the crossreference rows those
    // genre ids key, which is what makes the pairing load-bearing rather than
    // decorative.
    expect(results.map((r) => r.code_artist_number)).toEqual([1, 13]);
  });

  it('alias on: alias-only hit (branch B) carries genre_id', async () => {
    process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
    resetCatalogSearchAliasConfig();
    db.execute
      .mockResolvedValueOnce([
        rockIsis({
          alias_max_sim: 0.85,
          alias_matched_variant: 'Isis the band',
          alias_matched_source: 'discogs_name_variation',
        }),
      ])
      .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].genre_id).toBe(11);
  });

  it('track-title cascade hit (TaggedLibraryViewEntry mapper) carries genre_id', async () => {
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
        genre_id: 11,
        label: 'Sonamos',
        label_id: null,
        rotation_bin: null,
        plays: 12,
        on_streaming: true,
        album_artist: null,
        artist_id: 4200,
      },
    ]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].genre_id).toBe(11);
  });
});
