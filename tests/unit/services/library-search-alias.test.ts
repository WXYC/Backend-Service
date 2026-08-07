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
import {
  searchLibrary as searchCatalogQuery,
  type CatalogSort,
  type CatalogOrder,
} from '../../../apps/backend/services/library-search.service';
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

/**
 * Flatten the `tests/__mocks__/drizzle-orm.ts` stand-in for a Drizzle `SQL`
 * object into readable text with its interpolated values inlined, so an
 * assertion can read like the SQL it pins (`similarity(asa.variant, monolake)
 * >= 0.4`) instead of like a JSON blob.
 *
 * The mocked `sql` tag returns `{ sql: TemplateStringsArray, values }`, and a
 * nested `sql` fragment shows up as one of those `values` — so rendering is
 * "interleave the literals with the recursively-rendered values". Columns come
 * from the mocked `@wxyc/database`, whose tables are plain string maps, so an
 * unmapped column renders as `undefined`; that's harmless here because every
 * assertion below targets literal SQL text or an unqualified sort alias.
 */
function renderSqlWithParams(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  const literals = (node as { sql?: unknown }).sql;
  if (Array.isArray(literals)) {
    const values = (node as { values?: unknown[] }).values ?? [];
    return literals
      .map((text, i) => `${String(text)}${i < values.length ? renderSqlWithParams(values[i]) : ''}`)
      .join('');
  }
  const raw = (node as { raw?: unknown }).raw;
  if (typeof raw === 'string') return raw;
  return JSON.stringify(node) ?? '';
}

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

    // ---------------------------------------------------------------------
    // BS#2018 — alias-branch fuzzy hits flooded the result set.
    //
    // `q=monolake` returned all 14 Bill Monroe albums ahead of the 6 Monolake
    // ones, because (1) Discogs artist 450691 carries the misprint variant
    // "Monore", which clears pg_trgm's 0.30 `%` threshold against "monolake"
    // by 0.03, and (2) `alias_max_sim` was projected but never used in ORDER
    // BY, so a 0.333 typo-collision sorted identically to an exact hit.
    //
    // Fix 1 tiers the sort (alias-only rows always after non-alias rows).
    // Fix 2 raises the alias match floor to 0.40.
    //
    // BS#2020 narrowed Fix 1's tier here to FUZZY alias-only rows. The
    // complaint above is about a 0.333 typo collision sorting like an exact
    // hit; demoting the exact hit too was collateral, not the goal. This path
    // paginates, so the collateral was survivable here and fatal on the two
    // `library.service.ts` paths — but the tier means one thing in all three
    // places, which is why it is built by one shared helper.
    // ---------------------------------------------------------------------
    describe('BS#2018 alias-noise floor + rank tiering', () => {
      const FUZZY_ALIAS_TIER = '(alias_max_sim IS NOT NULL AND alias_max_sim < 1) ASC';

      function runAliasQuery(
        params: { sort?: CatalogSort; order?: CatalogOrder } = {}
      ): Promise<{ data: string; count: string }> {
        stubGenreFormatLookups();
        db.execute.mockReset();
        db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);
        return searchCatalogQuery({ ...baseQueryParams, ...params }).then(() => ({
          data: renderSqlWithParams(db.execute.mock.calls[0]?.[0]),
          count: renderSqlWithParams(db.execute.mock.calls[1]?.[0]),
        }));
      }

      beforeEach(() => {
        process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
        delete process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
        resetCatalogSearchAliasConfig();
      });

      const originalFloor = process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
      afterAll(() => {
        // Restore rather than delete, matching the outer describe's handling of
        // CATALOG_SEARCH_ALIAS_ENABLED: a developer with the floor exported in
        // their shell should get their environment back, not a silently unset
        // var for the rest of the Jest worker.
        if (originalFloor === undefined) delete process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
        else process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = originalFloor;
        resetCatalogSearchAliasConfig();
      });

      it('Fix 2: the alias CTE post-filters on similarity >= the configured floor', async () => {
        const { data, count } = await runAliasQuery();

        // The `%` predicate stays — it is what drives the GIN trigram index
        // (`artist_search_alias_variant_trgm_idx`). The floor rides on top of
        // it as a filter, so the index scan is unchanged (BS#1318).
        expect(data).toContain('asa.variant % Thee Oh Sees');
        expect(data).toContain('similarity(asa.variant, Thee Oh Sees) >= 0.4');
        expect(count).toContain('asa.variant % Thee Oh Sees');
        expect(count).toContain('similarity(asa.variant, Thee Oh Sees) >= 0.4');
      });

      it('Fix 2: the floor is operator-tunable via CATALOG_SEARCH_ALIAS_MIN_SIMILARITY', async () => {
        // The AC for Fix 1 depends on this knob: with the floor back at 0.30
        // the noise rows return, which is the only way to observe the tiering.
        process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.3';
        resetCatalogSearchAliasConfig();

        const { data } = await runAliasQuery();

        expect(data).toContain('similarity(asa.variant, Thee Oh Sees) >= 0.3');
      });

      it('Fix 1: alias-only rows are tiered last, ahead of the caller sort', async () => {
        const { data } = await runAliasQuery();

        // The tier key must lead the ORDER BY, and the caller's own sort must
        // still follow it intact. `FALSE < TRUE` in Postgres, so ASC puts the
        // non-alias rows first.
        expect(data).toContain(`ORDER BY ${FUZZY_ALIAS_TIER}, artist_name ASC, album_title ASC, id ASC`);
      });

      const SORT_EXPECTATIONS: [CatalogSort, string, string][] = [
        ['artist', 'artist_name', 'album_title'],
        ['album', 'album_title', 'artist_name'],
        ['plays', 'plays', 'artist_name'],
        ['date', 'add_date', 'artist_name'],
      ];

      it.each(
        SORT_EXPECTATIONS.flatMap(([sort, primary, secondary]) =>
          (['asc', 'desc'] as const).map((order) => ({ sort, order, primary, secondary }))
        )
      )('Fix 1: tier leads the ORDER BY for sort=$sort order=$order', async ({ sort, order, primary, secondary }) => {
        const { data } = await runAliasQuery({ sort, order });

        const expected = `ORDER BY ${FUZZY_ALIAS_TIER}, ${primary} ${order.toUpperCase()}, ${secondary} ASC, id ASC`;
        expect(data).toContain(expected);
      });

      it('leaves the inner DISTINCT ON dedupe ordering untouched (BS#1554)', async () => {
        const { data } = await runAliasQuery();

        // The rotation-bin dedupe ordinal decides WHICH duplicate row
        // survives; perturbing it changes the surfaced rotation bin. The
        // tier belongs on the OUTER sort only.
        expect(data).toContain('ORDER BY id ASC, CASE rotation_bin');
        expect(data.slice(0, data.indexOf('ORDER BY id ASC, CASE rotation_bin'))).not.toContain(FUZZY_ALIAS_TIER);
      });

      it('alias OFF: neither the floor nor the tier appears (legacy path unchanged)', async () => {
        delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
        resetCatalogSearchAliasConfig();

        const { data, count } = await runAliasQuery();

        expect(data).not.toContain('similarity(asa.variant');
        expect(data).not.toContain(FUZZY_ALIAS_TIER);
        expect(data).not.toContain('alias_max_sim');
        expect(count).not.toContain('similarity(asa.variant');
        expect(data).toContain('ORDER BY artist_name ASC, album_title ASC, id ASC');
      });
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

  // -----------------------------------------------------------------------
  // BS#2020 — alias-only rows could displace real trigram matches.
  //
  // Both alias-aware paths in `library.service.ts` ranked alias-only rows and
  // real matches on a single `GREATEST(...)` scale. Branch (b) INNER JOINs on
  // `artist_id`, so ONE mid-scoring variant admits its artist's entire
  // discography at that score, and every one of those rows outranks any real
  // match scoring below it. Measured against a prod-shaped clone: the variant
  // "Monolake Live" (similarity 0.6429 vs `monolake` — an ordinary name
  // variation, comfortably over BS#2018's 0.40 floor) put 6 Bill Monroe
  // albums on the page and pushed Mono (0.400), Monolord (0.385), Monos
  // (0.364), Midlake / Monokle / Monopot (0.308) off it entirely.
  //
  // Distinct from BS#2018, which fixed `/library/query` — a path whose
  // ORDER BY had no relevance term at all. Here relevance ordering already
  // exists and must be PRESERVED inside each tier, not replaced.
  //
  // The tier demotes FUZZY alias hits only. An `alias_max_sim` of 1 means the
  // query string IS a registered name for that artist, which is at least as
  // strong a claim as a 0.31 trigram smear on a canonical name; demoting it
  // on these two paths would delete it, not reorder it, because neither emits
  // an OFFSET. See `buildFuzzyAliasTier` for the full argument.
  //
  // `id ASC` is new on both sites: neither had any tie-break, and within the
  // alias tier every row of one artist shares an identical `alias_max_sim`,
  // so their relative order was whatever the plan happened to emit.
  // -----------------------------------------------------------------------
  describe('BS#2020 alias-only rows tier after real trigram matches', () => {
    const FUZZY_ALIAS_TIER = '(alias_max_sim IS NOT NULL AND alias_max_sim < 1) ASC';
    const flat = (text: string) => text.replace(/\s+/g, ' ');

    beforeEach(() => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
    });

    /** Render the alias-aware SQL emitted by the Both-mode trigram tier. */
    async function renderBothModeSql(query = 'monolake'): Promise<string> {
      // tsvector tier must return 0 rows so the trigram tier fires.
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);
      db.execute.mockReset();
      db.execute.mockResolvedValue([]);

      await searchLibrary(query);

      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeDefined();
      return flat(renderSqlWithParams(aliasCall?.[0]));
    }

    /** Render the alias-aware SQL emitted by the request-line artist path. */
    async function renderByArtistSql(query = 'monolake'): Promise<string> {
      db.select.mockReset();
      db.execute.mockReset();
      db.execute.mockResolvedValue([]);

      await searchByArtist(query);

      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeDefined();
      return flat(renderSqlWithParams(aliasCall?.[0]));
    }

    it('Both-mode: the tier leads the ORDER BY, relevance still ranks inside it', async () => {
      const rendered = await renderBothModeSql();

      // Tier FIRST, or a 0.64 alias row still outranks a 0.40 real one.
      expect(rendered).toContain(`ORDER BY ${FUZZY_ALIAS_TIER}, GREATEST(`);
      // GREATEST must survive intact: within a tier the strongest hit leads.
      expect(rendered).toContain('similarity(artist_name, monolake)');
      expect(rendered).toContain('similarity(album_title, monolake)');
      expect(rendered).toContain('COALESCE(alias_max_sim, 0)');
      expect(rendered).toContain(') DESC, id ASC');
    });

    it('request-line: the tier leads the ORDER BY (single-column relevance)', async () => {
      const rendered = await renderByArtistSql();

      expect(rendered).toContain(`ORDER BY ${FUZZY_ALIAS_TIER}, GREATEST(`);
      expect(rendered).toContain('similarity(artist_name, monolake)');
      expect(rendered).toContain('COALESCE(alias_max_sim, 0)');
      expect(rendered).toContain(') DESC, id ASC');
      // No album_title predicate on this path, so none in the ranking either.
      expect(rendered).not.toContain('similarity(album_title');
    });

    it.each([
      ['Both-mode', renderBothModeSql],
      ['request-line', renderByArtistSql],
    ])('%s: the tier sorts ASC so real matches come first (FALSE < TRUE)', async (_label, render) => {
      const rendered = await render();

      // Assert presence before absence. A bare `not.toContain` here would
      // pass against a build with no tier at all — the vacuous-guard trap
      // BS#2019 shipped and had to fix.
      expect(rendered).toContain(FUZZY_ALIAS_TIER);
      // The single most reversible mistake: DESC inverts the fix and
      // promotes every alias row above every real match.
      expect(rendered).not.toContain('(alias_max_sim IS NOT NULL AND alias_max_sim < 1) DESC');
    });

    it.each([
      ['Both-mode', renderBothModeSql],
      ['request-line', renderByArtistSql],
    ])('%s: an exact-variant hit is exempt from the tier, not merely ranked high', async (_label, render) => {
      const rendered = await render();

      // The exemption has to live in the TIER, not in the relevance term.
      // `GREATEST` already promotes a 1.0 alias hit to the top of its tier —
      // and that is exactly what is not enough: an unconditional tier puts
      // the whole alias group behind every real match, and on these two
      // paths (bare LIMIT, no OFFSET) behind means gone. So assert the
      // score guard is part of the tier predicate itself.
      expect(rendered).toContain('alias_max_sim < 1');
      expect(rendered).not.toContain('ORDER BY (alias_max_sim IS NOT NULL) ASC');
    });

    it('Both-mode alias OFF: the legacy chained-builder ordering is untouched', async () => {
      delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain([]);
      trigramChain.limit = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });
      db.execute.mockReset();
      db.execute.mockResolvedValue([]);

      await searchLibrary('monolake');

      // BS#1318 requires the alias-OFF path stay byte-identical so the
      // planner keeps reaching the per-column GIN trigram indexes. The tier
      // references a column that branch (a) alone does not project.
      const ordering = trigramChain.orderBy.mock.calls.flat().map(renderSqlWithParams).join(' | ');
      expect(ordering).not.toContain('alias_max_sim');
      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeUndefined();
    });
  });
});
