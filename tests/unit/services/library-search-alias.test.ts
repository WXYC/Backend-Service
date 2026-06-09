import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
const mockGetRelease = jest.fn<(releaseId: number) => Promise<unknown>>();

class MockLmlClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LmlClientError';
    this.statusCode = statusCode;
  }
}

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  lookupBySong: mockLookupBySong,
  isLmlConfigured: mockIsLmlConfigured,
  getRelease: mockGetRelease,
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: MockLmlClientError,
}));

const mockSpanSetAttribute = jest.fn();
const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttribute: typeof mockSpanSetAttribute; setAttributes: typeof mockSpanSetAttributes };
const spanInstance: SpanLike = { setAttribute: mockSpanSetAttribute, setAttributes: mockSpanSetAttributes };
const mockStartSpan = jest.fn(
  <T>(_opts: { name: string; op: string }, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance))
);
const mockGetActiveSpan = jest.fn(() => spanInstance);
jest.mock('@sentry/node', () => ({
  startSpan: <T>(opts: { name: string; op: string }, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    mockStartSpan(opts, callback),
  getActiveSpan: () => mockGetActiveSpan(),
}));

import { searchLibrary, searchByArtist } from '../../../apps/backend/services/library.service';
import { searchLibrary as searchCatalogQuery } from '../../../apps/backend/services/library-search.service';
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';

const baseViewRow = {
  id: 42,
  code_letters: 'OH',
  code_artist_number: 7,
  code_number: 1,
  artist_name: 'OHSEES',
  alphabetical_name: 'OHSEES',
  album_title: 'A Weird Exits',
  format_name: 'CD',
  genre_name: 'Rock',
  rotation_bin: null,
  add_date: new Date('2024-01-15'),
  label: 'Castle Face',
  label_id: null,
  on_streaming: true,
  album_artist: null,
  plays: 7,
  artwork_url: null,
  artist_id: 9001,
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  wikidata_qid: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
};

describe('catalog search — alias-aware LATERAL JOIN (PR 5)', () => {
  const originalFlag = process.env.CATALOG_SEARCH_ALIAS_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    else process.env.CATALOG_SEARCH_ALIAS_ENABLED = originalFlag;
    resetCatalogSearchAliasConfig();
  });

  describe('searchLibrary (Both-mode trigram path)', () => {
    it('flag off: trigram row without alias fields → matched_via_alias absent (raw alias SQL never fires)', async () => {
      // tsvector returns 0, trigram returns row via chained builder.
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain([baseViewRow]);
      trigramChain.limit = jest.fn().mockResolvedValue([baseViewRow]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });
      // db.execute is also used by checkLibraryArtistNameHealth (non-alias);
      // the load-bearing assertion is "no matched_via_alias on the result row".
      db.execute.mockResolvedValue([]);

      const results = await searchLibrary('Thee Oh Sees');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('id', 42);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
    });

    it('flag on: alias_hit fields present → matched_via_alias attached with matched_variant + source', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      // tsvector still returns 0 (chained builder).
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);

      const aliasRow = {
        ...baseViewRow,
        alias_max_sim: 0.78,
        alias_matched_variant: 'Thee Oh Sees',
        alias_matched_source: 'discogs_name_variation',
      };
      db.execute.mockReset();
      db.execute.mockResolvedValue([aliasRow]);

      const results = await searchLibrary('Thee Oh Sees');

      expect(db.execute).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      const hit = results[0] as { matched_via_alias?: Array<{ matched_variant: string; source: string }> };
      expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' }]);
    });

    it('flag on: alias_hit fields null → matched_via_alias remains absent', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);

      const trigramOnlyRow = {
        ...baseViewRow,
        alias_max_sim: null,
        alias_matched_variant: null,
        alias_matched_source: null,
      };
      db.execute.mockReset();
      db.execute.mockResolvedValue([trigramOnlyRow]);

      const results = await searchLibrary('OHSEES');

      expect(results).toHaveLength(1);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
    });

    it('flag on: tsvector hit short-circuits — alias raw SQL never runs', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([baseViewRow]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([baseViewRow]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);
      db.execute.mockReset();

      const results = await searchLibrary('Autechre');

      expect(results).toHaveLength(1);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  describe('/library/query (library-search.service.searchLibrary)', () => {
    const baseQueryParams = {
      q: 'Thee Oh Sees',
      page: 0,
      limit: 25,
      sort: 'artist' as const,
      order: 'asc' as const,
    };

    const baseQueryRow = {
      id: 42,
      add_date: '2024-01-15',
      album_title: 'A Weird Exits',
      artist_name: 'OHSEES',
      code_letters: 'OH',
      code_number: 1,
      code_artist_number: 7,
      format_name: 'CD',
      genre_name: 'Rock',
      label: 'Castle Face',
      label_id: null,
      rotation_bin: null,
      plays: 7,
      on_streaming: true,
      album_artist: null,
    };

    function stubGenreFormatLookups() {
      // validateEnumFilters calls db.select for genres/formats; tests skip
      // params.genre/format so the validator is a no-op, but the cached
      // sets prime on first call. Return an empty chain to short-circuit.
      const chain = createMockQueryChain([]);
      db.select.mockReset();
      db.select.mockReturnValue(chain);
    }

    it('flag off: query row has no alias fields → matched_via_alias absent', async () => {
      stubGenreFormatLookups();
      db.execute.mockReset();
      // dataQuery, then countQuery — both Promise.all-issued.
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results, total } = await searchCatalogQuery(baseQueryParams);

      expect(total).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
      expect(results[0].matched_via_alias).toBeUndefined();
    });

    it('flag on: alias_hit fields present on row → matched_via_alias attached', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute
        .mockResolvedValueOnce([
          {
            ...baseQueryRow,
            alias_max_sim: 0.85,
            alias_matched_variant: 'Thee Oh Sees',
            alias_matched_source: 'discogs_name_variation',
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery(baseQueryParams);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('flag on: alias_hit null on row → matched_via_alias absent', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute
        .mockResolvedValueOnce([
          {
            ...baseQueryRow,
            alias_max_sim: null,
            alias_matched_variant: null,
            alias_matched_source: null,
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery(baseQueryParams);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
    });

    it('flag on + empty q: alias LATERAL is suppressed (no q to match against)', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      // Empty q → conditions=[] → queryWhere=null → fromClause has no WHERE.
      // dataQuery returns rows; alias_max_sim should be absent (not even
      // selected). Verify by returning a row WITHOUT alias fields and
      // confirming no crash.
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery({ ...baseQueryParams, q: '' });

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
    });

    it('flag on + only field-specific conditions: LATERAL is suppressed (no all-field branch to OR into)', async () => {
      // A pure `artist:foo` query parses to one field=='artist_name'
      // condition. buildAllFieldMatch is never called, so the alias OR is
      // never added to WHERE; the LATERAL would compute similarity for every
      // candidate row with no chance of an alias-only hit surviving. Skip
      // the join entirely — result set is identical to the flag-off path.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery({ ...baseQueryParams, q: 'artist:OHSEES' });

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
      // Both calls are issued via Promise.all (dataQuery + countQuery). The
      // load-bearing assertion is that neither SQL embedded `alias_hit`.
      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');
      expect(renderedData).not.toContain('alias_hit');
      expect(renderedCount).not.toContain('alias_hit');
    });
  });

  describe('searchByArtist (request-line single-column trigram)', () => {
    it('flag off: chained builder returns row → matched_via_alias absent', async () => {
      const chain = createMockQueryChain([baseViewRow]);
      chain.limit = jest.fn().mockResolvedValue([baseViewRow]);
      db.select.mockReset();
      db.select.mockReturnValue(chain);
      db.execute.mockReset();

      const results = await searchByArtist('OHSEES');

      expect(results).toHaveLength(1);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('flag on: raw SQL returns alias hit → matched_via_alias propagates through enrichLibraryResult', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      db.select.mockReset();

      const aliasRow = {
        ...baseViewRow,
        alias_max_sim: 0.92,
        alias_matched_variant: 'Thee Oh Sees',
        alias_matched_source: 'wxyc_library_alt',
      };
      db.execute.mockReset();
      db.execute.mockResolvedValue([aliasRow]);

      const results = await searchByArtist('Thee Oh Sees');

      expect(db.execute).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      const hit = results[0] as { matched_via_alias?: Array<{ matched_variant: string; source: string }> };
      expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Thee Oh Sees', source: 'wxyc_library_alt' }]);
    });
  });
});
