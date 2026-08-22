import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * BS#2227: `artist_id` must reach `AlbumSearchResultRow` on every path that
 * produces one.
 *
 * What this file covers, and what it deliberately does not:
 *
 * These tests pin the two MAPPERS (`toAlbumSearchResultRow`,
 * `taggedRowToAlbumSearchResultRow`) — that each carries `artist_id` from its
 * input row to its output. They cannot verify that the SQL selects the column
 * at all: `db.execute` is a bare mock that ignores its argument, and every
 * fixture below supplies `artist_id` by hand, so deleting the
 * `AS artist_id` projections from the SELECTs leaves this whole file green.
 *
 * Coverage of the projections themselves is therefore the integration suite's
 * job, against real SQL: `tests/integration/library-query.spec.js` asserts
 * `typeof hit.artist_id === 'number'` on a CTA cascade hit. Add an assertion
 * there, not here, when a new search path starts producing these rows.
 *
 * Note the cascade's CTA arm does NOT read `library_artist_view` — it joins
 * `compilation_track_artist` / `library` / `artists` itself. Since BS#2231 it
 * projects the shared `LIBRARY_VIEW_PROJECTION_RAW` rather than a hand-rolled
 * column list, so `artist_id` reaches it by construction; what pins that is
 * `library-cta-projection.test.ts`, not this file.
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

describe('searchLibrary: artist_id on AlbumSearchResultRow (BS#2227)', () => {
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

  it('alias off: direct-hit row carries artist_id', async () => {
    db.execute.mockResolvedValueOnce([primaryRow()]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artist_id).toBe(501);
  });

  it('alias on: alias-only hit (branch B) carries artist_id', async () => {
    process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
    resetCatalogSearchAliasConfig();
    db.execute
      .mockResolvedValueOnce([
        primaryRow({
          artist_id: 502,
          alias_max_sim: 0.85,
          alias_matched_variant: 'Autecher',
          alias_matched_source: 'discogs_name_variation',
        }),
      ])
      .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artist_id).toBe(502);
    expect(results[0].matched_via_alias).toEqual([{ matched_variant: 'Autecher', source: 'discogs_name_variation' }]);
  });

  it('V/A compilation hit returns the shared compilation artist id, not null', async () => {
    db.execute
      .mockResolvedValueOnce([
        primaryRow({
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

  it('track-title cascade hit (TaggedLibraryViewEntry mapper) carries artist_id', async () => {
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
        rotation_bin: null,
        plays: 12,
        on_streaming: true,
        album_artist: null,
        artist_id: 4200,
      },
    ]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].artist_id).toBe(4200);
  });
});
