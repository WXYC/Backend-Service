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

import {
  searchLibrary,
  searchByArtist,
  __resetTrackSearchCacheForTests,
} from '../../../apps/backend/services/library.service';
import { searchLibrary as searchCatalogQuery } from '../../../apps/backend/services/library-search.service';
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';
import { resetConfig as resetCatalogTrackSearchConfig } from '../../../apps/backend/config/catalogTrackSearch';

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

  describe('searchLibrary (Both-mode) — alias-only trigram hits no longer suppress the cascade (BS#1885)', () => {
    const originalCta = process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
    const originalDiscogs = process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;

    beforeEach(() => {
      delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      resetCatalogTrackSearchConfig();
      __resetTrackSearchCacheForTests();
    });

    afterAll(() => {
      if (originalCta === undefined) delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      else process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = originalCta;
      if (originalDiscogs === undefined) delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      else process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = originalDiscogs;
      resetCatalogTrackSearchConfig();
    });

    it('a genuine (non-alias) trigram row present — early return, cascade never runs', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);

      db.execute.mockReset();
      db.execute.mockResolvedValue([
        { ...baseViewRow, alias_max_sim: null, alias_matched_variant: null, alias_matched_source: null },
        {
          ...baseViewRow,
          id: 43,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      const results = await searchLibrary('OHSEES');

      expect(mockLookupBySong).not.toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('all trigram rows alias-tagged, cascade flags off — rows returned unchanged', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);

      db.execute.mockReset();
      db.execute.mockResolvedValue([
        {
          ...baseViewRow,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      const results = await searchLibrary('Thee Oh Sees');

      // Cascade flags default off, so runCatalogTrackSearchCascade no-ops
      // without touching LML or the DB — proving the alias-only rows aren't
      // silently swapped for an empty cascade result.
      expect(mockLookupBySong).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('all trigram rows alias-tagged, Track 2 (LML) resolves — merged cascade-first', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // Jessica Pratt / "On Your Own Love Again" — WXYC canonical fixture
      // (matches the Track 2 case in library.service.test.ts).
      const trackRow = {
        id: 101,
        code_letters: 'PR',
        code_artist_number: 1,
        code_number: 2,
        artist_name: 'Jessica Pratt',
        alphabetical_name: 'Pratt, Jessica',
        album_title: 'On Your Own Love Again',
        format_name: 'CD',
        genre_name: 'Rock',
        rotation_bin: null,
        add_date: new Date('2024-02-01'),
        label: 'Drag City',
        label_id: null,
        on_streaming: true,
        album_artist: null,
        plays: 12,
        artwork_url: null,
        legacy_release_id: 555,
        artist_id: 9002,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      // CTA/Track 1 stays off (only CATALOG_TRACK_SEARCH_DISCOGS_ENABLED is
      // set above), so `db.select` is only called for: tsvector, the Track 2
      // library bridge query, and the CTA-exclusion query — no separate
      // alias-off trigram `db.select` call, since the alias-enabled trigram
      // path reads via raw `db.execute` SQL instead.
      const chains = [tsvectorChain, libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });

      db.execute.mockReset();
      db.execute.mockResolvedValue([
        {
          ...baseViewRow,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      mockLookupBySong.mockReset();
      mockLookupBySong.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 555,
              title: 'On Your Own Love Again',
              artist: 'Jessica Pratt',
              call_number: 'Rock CD PR 1/2',
              library_url: 'https://library.wxyc.org/release/555',
            },
            matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await searchLibrary('Back, Baby');

      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
      // Cascade-first ordering.
      expect(results[0].id).toBe(101);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'discogs_release' });
      const aliasHit = results.find((r) => r.id === 42);
      expect(aliasHit?.matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('BS#1886: Track 2 resolves a non-streaming row under on_streaming=true — cascade row is scoped out, never leaks', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // The Track 2 bridge row is NOT on streaming. `searchLibraryByTrackRaw`
      // does not honor `on_streaming`, so without the shared-cascade scope it
      // would leak into an `on_streaming=true` result (Both-mode has no
      // in-memory re-filter of its own, unlike `/library/query`).
      const nonStreamingTrackRow = {
        id: 101,
        code_letters: 'PR',
        code_artist_number: 1,
        code_number: 2,
        artist_name: 'Jessica Pratt',
        alphabetical_name: 'Pratt, Jessica',
        album_title: 'On Your Own Love Again',
        format_name: 'CD',
        genre_name: 'Rock',
        rotation_bin: null,
        add_date: new Date('2024-02-01'),
        label: 'Drag City',
        label_id: null,
        on_streaming: false,
        album_artist: null,
        plays: 12,
        artwork_url: null,
        legacy_release_id: 555,
        artist_id: 9002,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const libraryChain = createMockQueryChain([nonStreamingTrackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([nonStreamingTrackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      const chains = [tsvectorChain, libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });

      db.execute.mockReset();
      db.execute.mockResolvedValue([
        {
          ...baseViewRow,
          on_streaming: true,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      mockLookupBySong.mockReset();
      mockLookupBySong.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 555,
              title: 'On Your Own Love Again',
              artist: 'Jessica Pratt',
              call_number: 'Rock CD PR 1/2',
              library_url: 'https://library.wxyc.org/release/555',
            },
            matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await searchLibrary('Back, Baby', undefined, undefined, 5, true);

      // The cascade ran (LML was consulted) but its sole row is non-streaming,
      // so it's scoped out; only the streaming alias trigram row survives.
      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
      expect(results.find((r) => r.id === 101)).toBeUndefined();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
    });

    it('BS#1886: cascade row collides with an alias id — merge carries matched_via_alias onto the cascade row', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // Cascade bridge row shares id 42 with the alias trigram row below.
      const collidingTrackRow = {
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
        legacy_release_id: 555,
        artist_id: 9001,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const libraryChain = createMockQueryChain([collidingTrackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([collidingTrackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      const chains = [tsvectorChain, libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });

      db.execute.mockReset();
      db.execute.mockResolvedValue([
        {
          ...baseViewRow,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      mockLookupBySong.mockReset();
      mockLookupBySong.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 555,
              title: 'A Weird Exits',
              artist: 'OHSEES',
              call_number: 'Rock CD OH 1/7',
              library_url: 'https://library.wxyc.org/release/555',
            },
            matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await searchLibrary('Back, Baby');

      // Single merged row (ids collide): the cascade's matched_via is the
      // stronger signal AND the alias hint rides along, matching the
      // `/library/query` merge.
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'discogs_release' });
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
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
        // BS#1885: this row is alias-only (total_non_alias: 0), so the new
        // gate falls through toward the cascade guards — proven harmless
        // here because searchLibrary (library.service) isn't mocked in this
        // file and the cascade flags default off, so runCatalogTrackSearchCascade
        // resolves [] and the alias row passes through unchanged.
        .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

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
        // BS#1885: a genuine (non-alias) row — total_non_alias: 1 pins the
        // short-circuit gate (no cascade fallthrough for a real primary hit).
        .mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);

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

    it('flag on + only field-specific conditions: alias path is suppressed (gated on all-field condition)', async () => {
      // A pure `artist:foo` query parses to one field=='artist_name'
      // condition with no `field === 'all'` member, so `hasAllFieldCondition`
      // is false and `aliasActive` is false. The catalog query falls through
      // to the legacy single-SELECT path — no CTE, no UNION ALL, no alias
      // substrate join — preserving pre-#1318 behavior for field-specific
      // queries.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery({ ...baseQueryParams, q: 'artist:OHSEES' });

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
      // Both calls are issued via Promise.all (dataQuery + countQuery). The
      // load-bearing assertion is that neither SQL embedded the alias
      // substrate join (LATERAL alias_hit or CTE alias_hits).
      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');
      expect(renderedData).not.toContain('alias_hit');
      expect(renderedCount).not.toContain('alias_hit');
      expect(renderedData).not.toContain('alias_hits');
      expect(renderedCount).not.toContain('alias_hits');
    });

    it('flag on: branch-B dedupe predicate is NULL-safe so alias-only NULL-label rows survive (BS#1557)', async () => {
      // BS#1557 regression pin. `queryWhereAliasOff` is
      // `(artist ILIKE q OR album ILIKE q OR label ILIKE q)`. `library.label`
      // is nullable, so for an alias-only hit whose matched album has a NULL
      // label the predicate evaluates to NULL (FALSE OR FALSE OR NULL). The
      // old dedupe `NOT (queryWhereAliasOff)` is then `NOT NULL = NULL`, which
      // drops the row from branch B — exactly the row the alias path exists to
      // surface. The fix uses the NULL-safe `(queryWhereAliasOff) IS NOT TRUE`.
      //
      // The mocked DB can't exercise Postgres three-valued logic, so the
      // load-bearing assertion is on the rendered dedupe predicate: it must be
      // the `IS NOT TRUE` form. We also confirm a NULL-label alias-only row the
      // mock returns still projects through unharmed.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();

      const nullLabelAliasRow = {
        ...baseQueryRow,
        label: null,
        alias_max_sim: 0.81,
        alias_matched_variant: 'Thee Oh Sees',
        alias_matched_source: 'discogs_name_variation',
      };
      db.execute.mockReset();
      // BS#1885: alias-only row (total_non_alias: 0).
      db.execute.mockResolvedValueOnce([nullLabelAliasRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

      const { results } = await searchCatalogQuery(baseQueryParams);

      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');

      // The NULL-safe dedupe form must be present in both arms of the UNION.
      expect(renderedData).toContain('IS NOT TRUE');
      expect(renderedCount).toContain('IS NOT TRUE');

      // The NULL-label alias-only row still surfaces with its alias hint.
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
      expect(results[0].label).toBe('');
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('flag on: emits ALT1 UNION ALL shape with alias_hits CTE (BS#1318)', async () => {
      // BS#1318 regression pin: the alias-aware catalog path must use the
      // CTE + UNION ALL form, not the LATERAL JOIN. The LATERAL had a 3-6.5×
      // p95 regression on selective queries because it picked the PK btree
      // and filtered `variant % q` row-by-row, never touching the GIN
      // trigram index. UNION ALL with a CTE lets the planner run the
      // trigram bitmap scan once.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      // baseQueryRow carries no alias fields — a genuine (non-alias) row.
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);

      await searchCatalogQuery(baseQueryParams);

      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');

      // Positive: CTE + UNION ALL appear in both queries (data + count).
      expect(renderedData).toContain('alias_hits');
      expect(renderedData).toContain('UNION ALL');
      expect(renderedCount).toContain('alias_hits');
      expect(renderedCount).toContain('UNION ALL');

      // Negative: the LATERAL JOIN must be gone — that's the whole point.
      // `alias_hit` (singular) was the LATERAL alias; with UNION ALL we
      // project from `alias_hits` (the CTE name) instead.
      expect(renderedData).not.toContain('alias_hit ON true');
      expect(renderedCount).not.toContain('alias_hit ON true');
      expect(renderedData).not.toContain('LEFT JOIN LATERAL');
      expect(renderedCount).not.toContain('LEFT JOIN LATERAL');
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

    it('flag on: emits ALT1 UNION ALL shape with alias_hits CTE (BS#1318)', async () => {
      // BS#1318 regression pin for the request-line single-column trigram
      // path. Same root cause as the catalog `/library/query` path: the
      // LATERAL was correlated on artist_id and never used the GIN trigram
      // index. UNION ALL with a CTE fixes the plan.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      db.select.mockReset();
      db.execute.mockReset();
      db.execute.mockResolvedValue([]);

      await searchByArtist('Thee Oh Sees');

      const call = db.execute.mock.calls[0]?.[0];
      const rendered = JSON.stringify(call ?? '');
      expect(rendered).toContain('alias_hits');
      expect(rendered).toContain('UNION ALL');
      expect(rendered).not.toContain('alias_hit ON true');
      expect(rendered).not.toContain('LEFT JOIN LATERAL');
    });
  });

  describe('searchLibrary (Both-mode trigram path) — ALT1 UNION ALL shape (BS#1318)', () => {
    it('flag on: emits ALT1 UNION ALL shape with alias_hits CTE', async () => {
      // BS#1318 regression pin for the Both-mode trigram fallback in
      // `searchLibraryByTrigramBoth`. The tsvector tier returns 0 rows so
      // the trigram tier fires; assert the SQL uses the new CTE + UNION ALL
      // form rather than the LATERAL JOIN.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);
      db.execute.mockReset();
      db.execute.mockResolvedValue([]);

      await searchLibrary('Thee Oh Sees');

      // db.execute is called once for the alias-aware trigram query (and
      // potentially for `checkLibraryArtistNameHealth` — but only the
      // alias-aware call embeds the CTE/UNION ALL keywords).
      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeDefined();
      const rendered = JSON.stringify(aliasCall?.[0] ?? '');
      expect(rendered).toContain('alias_hits');
      expect(rendered).toContain('UNION ALL');
      expect(rendered).not.toContain('alias_hit ON true');
      expect(rendered).not.toContain('LEFT JOIN LATERAL');
    });
  });
});
