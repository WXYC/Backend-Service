import { jest } from '@jest/globals';
import { db, createMockQueryChain, library, library_artist_view, album_plays } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  lookupBySong: mockLookupBySong,
  isLmlConfigured: mockIsLmlConfigured,
}));

// Mock @sentry/node so we can assert that searchLibraryByTrack creates a
// catalog.track_search span and projects per-search measurements onto it
// without initializing Sentry. startSpan(opts, callback) wraps a span mock
// and returns the callback's result — preserving the function's return
// value and generic. getActiveSpan() returns the same span instance so
// the inner method's `Sentry.getActiveSpan()?.setAttributes(...)` lands
// on the outer span the test asserts against.
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
  isISODate,
  fuzzySearchLibrary,
  searchLibrary,
  searchByArtist,
  searchAlbumsByTitle,
  searchLibraryByCTA,
  searchLibraryByTrack,
  runCatalogTrackSearchCascade,
  __resetTrackSearchCacheForTests,
  getAlbumFromDB,
  markAlbumMissing,
  markAlbumFound,
  enrichWithArtwork,
  updateArtworkUrl,
} from '../../../apps/backend/services/library.service';
import { resetConfig as resetCatalogTrackSearchConfig } from '../../../apps/backend/config/catalogTrackSearch';

/**
 * Recursively collect every scalar interpolation from a mock-`sql` tagged
 * template (and any nested `sql` fragments inside its `values`). The
 * drizzle-orm auto-mock returns `{ sql, values }` for each tag; the helper
 * lets tests assert that a specific value landed somewhere in the SQL tree
 * without caring which sub-fragment owns it.
 */
function flattenSqlValues(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const values = (node as { values?: unknown[] }).values;
  if (!Array.isArray(values)) return [];
  const out: unknown[] = [];
  for (const value of values) {
    if (value && typeof value === 'object' && 'sql' in value) {
      out.push(...flattenSqlValues(value));
    } else {
      out.push(value);
    }
  }
  return out;
}

describe('library.service', () => {
  describe('fuzzySearchLibrary', () => {
    const mockViewRow = {
      id: 1,
      code_letters: 'AU',
      code_artist_number: 3,
      code_number: 2,
      artist_name: 'Autechre',
      alphabetical_name: 'Autechre',
      album_title: 'Confield',
      format_name: 'cd',
      genre_name: 'Electronic',
      rotation_bin: null,
      add_date: new Date('2024-01-15'),
      label: 'Warp',
      label_id: null,
      on_streaming: true,
      album_artist: null,
      plays: 5,
      artwork_url: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns results with code_artist_number mapped from the view', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await fuzzySearchLibrary('Autechre', undefined, 5);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('code_artist_number', 3);
    });

    it('applies on_streaming filter when provided', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await fuzzySearchLibrary('Autechre', undefined, 5, true);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('on_streaming', true);
    });
  });

  // Shared mock view row for search function tests
  const mockViewRow = {
    id: 1,
    code_letters: 'AU',
    code_artist_number: 3,
    code_number: 2,
    artist_name: 'Autechre',
    alphabetical_name: 'Autechre',
    album_title: 'Confield',
    format_name: 'cd',
    genre_name: 'Electronic',
    rotation_bin: null,
    add_date: new Date('2024-01-15'),
    label: 'Warp',
    label_id: null,
    on_streaming: true,
    album_artist: null,
    plays: 5,
    artwork_url: null,
  };

  describe('searchLibrary', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('maps code_artist_number from the view into codeArtistNumber', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchLibrary('Autechre');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('codeArtistNumber', 3);
    });

    it('routes free-text query through library + album_plays join (not library_artist_view)', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      await searchLibrary('stereolab transient');

      // Tsvector path reads from `library` directly so the search_doc GIN
      // index is reachable; reading from the view forces a 5-way join first.
      expect(chain.from).toHaveBeenCalledWith(library);
      expect(chain.from).not.toHaveBeenCalledWith(library_artist_view);
      // album_plays drives the play-weighted ranking factor.
      const leftJoinTables = chain.leftJoin.mock.calls.map((c) => c[0]);
      expect(leftJoinTables).toContain(album_plays);
    });

    it('returns empty without a DB call for pure-punctuation queries', async () => {
      const results = await searchLibrary('!!!');

      expect(results).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('falls back to trigram when tsvector returns 0 rows', async () => {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain([mockViewRow]);
      trigramChain.limit = jest.fn().mockResolvedValue([mockViewRow]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibrary('pikn floyd');

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(1);
    });

    it('does not fall back to trigram for single-character queries', async () => {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);

      const results = await searchLibrary('a');

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);
    });
  });

  /**
   * Track-search cascade (E1-3 + E2-4): when the tsvector + trigram primary
   * returns 0 hits, probe CTA (Track 1), then LML /lookup (Track 2). Each
   * layer is gated by its own env flag; flags default false so out-of-the-box
   * behavior is identical to today.
   */
  describe('searchLibrary cascade (CTA + LML fallback)', () => {
    const ctaRow = {
      id: 11,
      code_letters: 'VA',
      code_artist_number: 1,
      code_number: 5,
      artist_name: 'Various Artists',
      alphabetical_name: 'Various Artists',
      album_title: 'Edits',
      format_name: 'cd',
      genre_name: 'Electronic',
      rotation_bin: null,
      add_date: new Date('2024-01-15'),
      label: 'self-released',
      label_id: null,
      on_streaming: true,
      album_artist: null,
      plays: 0,
      artwork_url: null,
      discogs_artist_id: null,
      musicbrainz_artist_id: null,
      wikidata_qid: null,
      spotify_artist_id: null,
      apple_music_artist_id: null,
      bandcamp_id: null,
      cta_track_title: 'Call Your Name',
      cta_artist_name: 'Chuquimamani-Condori',
    };

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
    };

    const lookupItem = {
      library_item: {
        id: 555,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        call_number: 'Rock CD PR 1/2',
        library_url: 'http://www.wxyc.info/wxycdb/libraryRelease?id=555',
      },
      matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
    };

    const originalCta = process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
    const originalDiscogs = process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;

    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      // Reset the lazy singleton so each test's per-case env mutations
      // (a few lines below) re-load through `loadConfig()`.
      resetCatalogTrackSearchConfig();
      // Reset the Track 2 LRU so a hit from a previous test (same query +
      // flag state) doesn't suppress the LML / DB call this test is asserting.
      __resetTrackSearchCacheForTests();
    });

    afterAll(() => {
      if (originalCta === undefined) delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      else process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = originalCta;
      if (originalDiscogs === undefined) delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      else process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = originalDiscogs;
      resetCatalogTrackSearchConfig();
    });

    /**
     * Tsvector returns 0; trigram returns whatever `trigramRows` says.
     * Returns the recorded call counts so tests can assert the cascade order.
     */
    function setUpPrimarySearchMocks(trigramRows: object[] = []): void {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain(trigramRows);
      trigramChain.limit = jest.fn().mockResolvedValue(trigramRows);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });
    }

    /**
     * Add a third + fourth `db.select` chain for `searchLibraryByTrack`'s
     * library-bridge + cta-exclusion queries on top of the primary mocks.
     */
    function setUpPrimaryAndTrackMocks(trackRows: object[], ctaCoveredIds: number[] = []): void {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain([]);
      trigramChain.limit = jest.fn().mockResolvedValue([]);
      const libraryChain = createMockQueryChain(trackRows);
      libraryChain.limit = jest.fn().mockResolvedValue(trackRows);
      const ctaChain = createMockQueryChain(ctaCoveredIds.map((id) => ({ library_id: id })));
      ctaChain.where = jest.fn().mockResolvedValue(ctaCoveredIds.map((id) => ({ library_id: id })));
      const chains = [tsvectorChain, trigramChain, libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });
    }

    it('flag-off baseline: tsvector+trigram return 0 and no fallback fires', async () => {
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([]);

      const results = await searchLibrary('nilufer yanya');

      expect(results).toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('flag-off: tsvector hit still returns primary results unchanged', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);
      db.execute.mockResolvedValue([]);

      const results = await searchLibrary('Autechre');

      expect(results).toHaveLength(1);
      expect(results[0].matched_via).toBeUndefined();
      expect(db.execute).not.toHaveBeenCalled();
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('CTA flag on, primary returns 0 → CTA fires and matched_via.source=cta', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([ctaRow]);

      const results = await searchLibrary('Call Your Name');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(11);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'cta', title: 'Call Your Name', confidence: 1.0 });
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('CTA flag on, primary returns >0 → CTA NOT called (direct hits outrank fallback)', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchLibrary('Autechre');

      expect(results).toHaveLength(1);
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('Both flags on, primary 0 + CTA >0 → LML NOT called (CTA suppresses Track 2)', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([ctaRow]);

      const results = await searchLibrary('Call Your Name');

      expect(results).toHaveLength(1);
      expect(results[0].matched_via?.[0].source).toBe('cta');
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('Both flags on, primary 0 + CTA 0 → LML fires and matched_via propagates', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      setUpPrimaryAndTrackMocks([trackRow]);
      db.execute.mockResolvedValue([]);

      const results = await searchLibrary('Back, Baby');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'discogs_release', confidence: 0.92 });
    });

    it('LML flag on alone (CTA flag off), primary 0 → LML fires directly', async () => {
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      setUpPrimaryAndTrackMocks([trackRow]);

      const results = await searchLibrary('Back, Baby');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
      // CTA flag was off; the CTA probe should not have been queried.
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('Both flags on, all three layers miss → empty array', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([]);
      mockLookupBySong.mockResolvedValue({
        results: [],
        search_type: 'none',
        song_not_found: true,
        found_on_compilation: false,
      });

      const results = await searchLibrary('xyzzy-unknown-track');

      expect(results).toEqual([]);
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
    });

    it('CTA flag off, LML flag off: explicit "false" values keep cascade dormant', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'false';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'false';
      setUpPrimarySearchMocks();

      await searchLibrary('Call Your Name');

      expect(db.execute).not.toHaveBeenCalled();
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('threads on_streaming into the CTA fallback when flag is on', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([ctaRow]);

      await searchLibrary('Call Your Name', undefined, undefined, 5, true);

      const sqlArg = db.execute.mock.calls[0]?.[0];
      expect(flattenSqlValues(sqlArg)).toContain(true);
    });
  });

  describe('fuzzySearchLibrary Both-mode routing', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('routes through tsvector + album_plays when artist_name and album_title are identical', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      await fuzzySearchLibrary('Stereolab', 'Stereolab', 5);

      expect(chain.from).toHaveBeenCalledWith(library);
      expect(chain.from).not.toHaveBeenCalledWith(library_artist_view);
      const leftJoinTables = chain.leftJoin.mock.calls.map((c) => c[0]);
      expect(leftJoinTables).toContain(album_plays);
    });

    it('keeps single-column path (no album_plays join) when only artist is provided', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      await fuzzySearchLibrary('Autechre', undefined, 5);

      const leftJoinTables = chain.leftJoin.mock.calls.map((c) => c[0]);
      expect(leftJoinTables).not.toContain(album_plays);
    });
  });

  /**
   * Both-mode catalog cascade reachable from fuzzySearchLibrary (BS#972).
   *
   * The catalog route GET /library/ calls fuzzySearchLibrary directly. With
   * both fields equal (dj-site's live-search shape), the both-mode branch
   * must run the same tsvector → trigram → CTA → LML cascade that
   * searchLibrary already runs at /library/search. Without this, catalog
   * clients never see matched_via even with the feature flags strict-`true`.
   *
   * These mirror the searchLibrary cascade cases — same mock chain shape —
   * but drive fuzzySearchLibrary(query, query, ...) directly.
   */
  describe('fuzzySearchLibrary Both-mode cascade (BS#972)', () => {
    const ctaRow = {
      id: 11,
      code_letters: 'VA',
      code_artist_number: 1,
      code_number: 5,
      artist_name: 'Various Artists',
      alphabetical_name: 'Various Artists',
      album_title: 'Edits',
      format_name: 'cd',
      genre_name: 'Electronic',
      rotation_bin: null,
      add_date: new Date('2024-01-15'),
      label: 'self-released',
      label_id: null,
      on_streaming: true,
      album_artist: null,
      plays: 0,
      artwork_url: null,
      discogs_artist_id: null,
      musicbrainz_artist_id: null,
      wikidata_qid: null,
      spotify_artist_id: null,
      apple_music_artist_id: null,
      bandcamp_id: null,
      cta_track_title: 'Call Your Name',
      cta_artist_name: 'Chuquimamani-Condori',
    };

    const originalCta = process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
    const originalDiscogs = process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;

    beforeEach(() => {
      jest.clearAllMocks();
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

    /** Tsvector returns 0 rows; trigram returns whatever caller provides. */
    function setUpPrimarySearchMocks(trigramRows: object[] = []): void {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain(trigramRows);
      trigramChain.limit = jest.fn().mockResolvedValue(trigramRows);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });
    }

    it('flag-off: tsvector hit returns plain row, no matched_via', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await fuzzySearchLibrary('Autechre', 'Autechre', 5);

      expect(results).toHaveLength(1);
      // matched_via must not be set on direct hits.
      expect((results[0] as { matched_via?: unknown }).matched_via).toBeUndefined();
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('flag-off baseline: primary 0 → no LML, returns []', async () => {
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([]);

      const results = await fuzzySearchLibrary('nilufer yanya', 'nilufer yanya', 5);

      expect(results).toEqual([]);
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('CTA flag on, primary 0 → CTA fires and matched_via.source=cta surfaces on the wire row', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      setUpPrimarySearchMocks();
      db.execute.mockResolvedValue([ctaRow]);

      const results = await fuzzySearchLibrary('Call Your Name', 'Call Your Name', 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(11);
      // Preserves the LibraryArtistViewEntry shape (label, add_date, etc.)
      // so the controller can serialize it as AlbumSearchResult.
      expect(results[0]).toHaveProperty('label', 'self-released');
      expect(results[0]).toHaveProperty('add_date');
      const matchedVia = (results[0] as { matched_via?: Array<{ source: string; title: string }> }).matched_via;
      expect(Array.isArray(matchedVia)).toBe(true);
      expect(matchedVia?.[0]).toMatchObject({ source: 'cta', title: 'Call Your Name' });
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('split-field query (artist !== title) does NOT trigger cascade', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      const chain = createMockQueryChain([]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([]);

      const results = await fuzzySearchLibrary('xyznoartist', 'xyznoalbum', 5);

      expect(results).toEqual([]);
      // Split-field path stays on the legacy fuzzy trigram path — no
      // db.execute (CTA SQL) and no LML lookup.
      expect(db.execute).not.toHaveBeenCalled();
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });
  });

  /**
   * Shared CTA → LML cascade slice (BS#982). Extracted from
   * `searchLibraryBothMode` and `library-search.service.ts::runCascade` so the
   * two callers don't drift on flag gating, ordering, or per-layer telemetry.
   *
   * These tests exercise the helper directly to pin the orchestration contract:
   *
   * - Both flags off → returns [] without touching either primitive.
   * - CTA-only → fires CTA; never falls through to Discogs.
   * - Discogs-only → fires Discogs (CTA primitive not called).
   * - Both on → CTA first; Discogs only when CTA returns 0.
   *
   * Mocks land at the same db / LML level as the existing cascade tests above,
   * since the helper calls the primitives by local symbol resolution inside
   * `library.service.ts`. The four flag combos are also covered end-to-end
   * via `searchLibrary` and `fuzzySearchLibrary` above; these helper-direct
   * tests are the new single source of truth that the refactor preserves.
   */
  describe('runCatalogTrackSearchCascade (BS#982)', () => {
    const ctaRow = {
      id: 11,
      code_letters: 'VA',
      code_artist_number: 1,
      code_number: 5,
      artist_name: 'Various Artists',
      alphabetical_name: 'Various Artists',
      album_title: 'Edits',
      format_name: 'cd',
      genre_name: 'Electronic',
      rotation_bin: null,
      add_date: new Date('2024-01-15'),
      label: 'self-released',
      label_id: null,
      on_streaming: true,
      album_artist: null,
      plays: 0,
      artwork_url: null,
      discogs_artist_id: null,
      musicbrainz_artist_id: null,
      wikidata_qid: null,
      spotify_artist_id: null,
      apple_music_artist_id: null,
      bandcamp_id: null,
      cta_track_title: 'Call Your Name',
      cta_artist_name: 'Chuquimamani-Condori',
    };

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
    };

    const lookupItem = {
      library_item: {
        id: 555,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        call_number: 'Rock CD PR 1/2',
        library_url: 'http://www.wxyc.info/wxycdb/libraryRelease?id=555',
      },
      matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
    };

    const originalCta = process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
    const originalDiscogs = process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;

    beforeEach(() => {
      jest.clearAllMocks();
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

    /** `searchLibraryByTrackRaw` issues two `db.select` calls (library bridge + cta exclusion). */
    function setUpTrackMocks(trackRows: object[], ctaCoveredIds: number[] = []): void {
      const libraryChain = createMockQueryChain(trackRows);
      libraryChain.limit = jest.fn().mockResolvedValue(trackRows);
      const ctaChain = createMockQueryChain(ctaCoveredIds.map((id) => ({ library_id: id })));
      ctaChain.where = jest.fn().mockResolvedValue(ctaCoveredIds.map((id) => ({ library_id: id })));
      const chains = [libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });
    }

    it('both flags off → returns [] without firing either primitive', async () => {
      const results = await runCatalogTrackSearchCascade('Call Your Name', 5);

      expect(results).toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('CTA only → CTA hits returns rows tagged matched_via.source=cta', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      db.execute.mockResolvedValue([ctaRow]);

      const results = await runCatalogTrackSearchCascade('Call Your Name', 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(11);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'cta', title: 'Call Your Name' });
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('CTA only → CTA misses returns [] (no Discogs fallthrough when flag off)', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      db.execute.mockResolvedValue([]);

      const results = await runCatalogTrackSearchCascade('xyzzy-unknown', 5);

      expect(results).toEqual([]);
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('Discogs only → Discogs hits, CTA primitive is not queried', async () => {
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      setUpTrackMocks([trackRow]);

      const results = await runCatalogTrackSearchCascade('Back, Baby', 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'discogs_release', confidence: 0.92 });
      // CTA SQL never ran.
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('both flags on → CTA hit suppresses Discogs lookup', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      db.execute.mockResolvedValue([ctaRow]);

      const results = await runCatalogTrackSearchCascade('Call Your Name', 5);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via?.[0].source).toBe('cta');
      expect(mockLookupBySong).not.toHaveBeenCalled();
    });

    it('both flags on → CTA miss falls through to Discogs', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      db.execute.mockResolvedValue([]);
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      setUpTrackMocks([trackRow]);

      const results = await runCatalogTrackSearchCascade('Back, Baby', 5);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via?.[0].source).toBe('discogs_release');
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('both flags on → both miss returns []', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      db.execute.mockResolvedValue([]);
      mockLookupBySong.mockResolvedValue({
        results: [],
        search_type: 'none',
        song_not_found: true,
        found_on_compilation: false,
      });

      const results = await runCatalogTrackSearchCascade('xyzzy-unknown-track', 5);

      expect(results).toEqual([]);
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
    });

    it('threads on_streaming into the CTA primitive', async () => {
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      // searchLibraryByCTARaw is responsible for honoring on_streaming via its
      // SQL; we assert here that the helper passes the third arg through by
      // observing the SQL fragment carries the boolean.
      db.execute.mockResolvedValue([]);

      await runCatalogTrackSearchCascade('Call Your Name', 5, true);

      expect(db.execute).toHaveBeenCalledTimes(1);
      const sqlArg = db.execute.mock.calls[0]?.[0];
      const flat = flattenSqlValues(sqlArg);
      expect(flat).toContain(true);
    });
  });

  describe('searchByArtist', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('maps code_artist_number from the view into codeArtistNumber', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchByArtist('Autechre');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('codeArtistNumber', 3);
    });
  });

  describe('searchAlbumsByTitle', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('maps code_artist_number from the view into codeArtistNumber', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchAlbumsByTitle('Confield');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('codeArtistNumber', 3);
    });
  });

  describe('searchLibraryByTrack', () => {
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
    };

    const lookupItem = {
      library_item: {
        id: 555,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        call_number: 'Rock CD PR 1/2',
        library_url: 'http://www.wxyc.info/wxycdb/libraryRelease?id=555',
      },
      matched_via: [
        {
          title: 'Back, Baby',
          artist_credit: null,
          confidence: 0.92,
          source: 'discogs',
        },
      ],
    };

    beforeEach(() => {
      jest.clearAllMocks();
      __resetTrackSearchCacheForTests();
    });

    it('returns enriched results with matched_via propagated from LML', async () => {
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      // Library bridge query (first db.select()) reads library rows.
      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      // CTA exclusion probe (second db.select() returning library_ids that ARE
      // covered by CTA — empty here means no exclusions). The CTA query has
      // no .limit(), so .where() must resolve to an array.
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
      expect(mockLookupBySong).toHaveBeenCalledWith('Back, Baby');
      // Bridge query reads from `library` (with joins) so the unique index
      // on legacy_release_id is reachable.
      expect(libraryChain.from).toHaveBeenCalledWith(library);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
      expect(results[0].artist).toBe('Jessica Pratt');
      expect(results[0].matched_via).toEqual([
        { title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs' },
      ]);
    });

    it('maps LML library.db.id to BS library.id via legacy_release_id', async () => {
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibraryByTrack('Back, Baby', 10);

      // The library-bridge query predicate must reference legacy_release_id.
      const whereArg = libraryChain.where.mock.calls[0]?.[0] as { inArray?: unknown[] };
      expect(whereArg.inArray).toEqual([library.legacy_release_id, [555]]);
      expect(results[0].id).toBe(101); // BS library.id, not LML's 555
    });

    it('returns empty array when LML returns no results (skips DB roundtrip)', async () => {
      mockLookupBySong.mockResolvedValue({
        results: [],
        search_type: 'none',
        song_not_found: false,
        found_on_compilation: false,
      });

      db.select.mockReset();

      const results = await searchLibraryByTrack('Nonexistent Song', 10);

      expect(results).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns empty array and swallows LML errors (fallback strategy must degrade gracefully)', async () => {
      mockLookupBySong.mockRejectedValue(new Error('LML 502 Bad Gateway'));
      db.select.mockReset();

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(results).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('excludes CTA-covered library rows for the same query (Track 1 will surface those)', async () => {
      // Second LML result for a release that IS in compilation_track_artist
      // with track_title ILIKE '%back, baby%'. Should be filtered out.
      const ctaRow = {
        ...trackRow,
        id: 102,
        album_title: 'Various - Drag City Sampler',
        artist_name: 'Various',
        legacy_release_id: 777,
      };
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem, { ...lookupItem, library_item: { ...lookupItem.library_item, id: 777 } }],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const libraryChain = createMockQueryChain([trackRow, ctaRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow, ctaRow]);
      // CTA probe says library_id=102 is covered.
      const ctaChain = createMockQueryChain([{ library_id: 102 }]);
      ctaChain.where = jest.fn().mockResolvedValue([{ library_id: 102 }]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
    });

    it("preserves LML's response order (BS does not re-rank)", async () => {
      // LML returns 777 first, 555 second. BS must emit the same order.
      const trackRowA = { ...trackRow, id: 201, legacy_release_id: 555 };
      const trackRowB = { ...trackRow, id: 202, legacy_release_id: 777, album_title: 'Album B' };
      mockLookupBySong.mockResolvedValue({
        results: [
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 777 } },
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 555 } },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      // DB returns them in whatever order Postgres picks (here, the wrong one).
      const libraryChain = createMockQueryChain([trackRowA, trackRowB]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRowA, trackRowB]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(results.map((r) => r.id)).toEqual([202, 201]);
    });

    it('still returns up to `limit` after CTA exclusion (filter runs post-fetch)', async () => {
      // LML returns 2 items; CTA covers the first. With limit=1, the caller
      // must still get one non-CTA result — not an empty array, which would
      // happen if .limit(1) ran at the DB and the surviving row was CTA-covered.
      const ctaRow = { ...trackRow, id: 301, legacy_release_id: 777 };
      const keepRow = { ...trackRow, id: 302, legacy_release_id: 555, album_title: 'Survives CTA' };
      mockLookupBySong.mockResolvedValue({
        results: [
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 777 } },
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 555 } },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const libraryChain = createMockQueryChain([ctaRow, keepRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([ctaRow, keepRow]);
      const ctaChain = createMockQueryChain([{ library_id: 301 }]);
      ctaChain.where = jest.fn().mockResolvedValue([{ library_id: 301 }]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibraryByTrack('Back, Baby', 1);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(302);
    });

    it('skips library rows whose legacy_release_id is unknown to BS (not in JOIN result)', async () => {
      // LML returned 999, but BS has no library row with legacy_release_id=999.
      // Drop it silently — the LML response is the source of truth on what
      // matched, but the legacy bridge is the source of truth on what BS holds.
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem, { ...lookupItem, library_item: { ...lookupItem.library_item, id: 999 } }],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
    });
  });

  /**
   * Track 2 LRU cache (E2-7). Memoizes the final mapped EnrichedLibraryResult[]
   * keyed by lowercased+trimmed query plus a hash of the catalog-track-search
   * flag state, so hits skip both the LML round-trip and the BS PG JOIN.
   */
  describe('searchLibraryByTrack cache (LRU)', () => {
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
    };

    const lookupItem = {
      library_item: {
        id: 555,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        call_number: 'Rock CD PR 1/2',
        library_url: 'http://www.wxyc.info/wxycdb/libraryRelease?id=555',
      },
      matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs' }],
    };

    /**
     * Configure mocks so the *first* call to `searchLibraryByTrack` hits LML +
     * DB; subsequent calls without resetting the mocks return whatever the
     * mock would return again (but we'll assert the cache short-circuits
     * before that).
     */
    function primeMocks(): void {
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });
    }

    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      resetCatalogTrackSearchConfig();
      __resetTrackSearchCacheForTests();
    });

    afterAll(() => {
      delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      resetCatalogTrackSearchConfig();
      __resetTrackSearchCacheForTests();
    });

    it('first call is a cache miss (invokes LML + DB)', async () => {
      primeMocks();

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
      expect(db.select).toHaveBeenCalled(); // PG JOIN ran
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
    });

    it('second identical call is a cache hit (skips LML + DB)', async () => {
      primeMocks();

      const first = await searchLibraryByTrack('Back, Baby', 10);
      const dbCallCountAfterMiss = db.select.mock.calls.length;
      const lmlCallCountAfterMiss = mockLookupBySong.mock.calls.length;

      const second = await searchLibraryByTrack('Back, Baby', 10);

      // Neither LML nor any DB select fired on the second call.
      expect(mockLookupBySong.mock.calls.length).toBe(lmlCallCountAfterMiss);
      expect(db.select.mock.calls.length).toBe(dbCallCountAfterMiss);
      // Result equality preserved, but the wrapper hands out a shallow copy so
      // caller-side sorts/mutations don't bleed into subsequent hits.
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(second[0].id).toBe(101);
      expect(second[0].matched_via?.[0]).toMatchObject({ source: 'discogs', confidence: 0.92 });
    });

    it('does not cache LML failures (next call retries instead of returning poisoned empty)', async () => {
      // First call: LML rejects. Wrapper degrades to [] but must NOT cache the
      // empty result — otherwise a transient LML blip would persist for 10
      // minutes, returning empty for every identical query.
      mockLookupBySong.mockRejectedValueOnce(new Error('LML 502 Bad Gateway'));
      db.select.mockReset();
      const firstResults = await searchLibraryByTrack('Back, Baby', 10);
      expect(firstResults).toEqual([]);
      const lmlCallsAfterFailure = mockLookupBySong.mock.calls.length;

      // Second call: LML recovers. The cache must NOT serve the empty result
      // from the failed call — LML has to be invoked again.
      primeMocks();
      const recovered = await searchLibraryByTrack('Back, Baby', 10);

      expect(mockLookupBySong.mock.calls.length).toBe(lmlCallsAfterFailure + 1);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe(101);
    });

    it('larger limit miss serves smaller limit hit without re-fetching', async () => {
      // The cache stores the un-sliced result. A miss at limit=10 plus a
      // subsequent hit at limit=5 should not re-invoke LML — slicing happens
      // on the read side.
      mockLookupBySong.mockResolvedValue({
        results: [
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 555 } },
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 556 } },
          { ...lookupItem, library_item: { ...lookupItem.library_item, id: 557 } },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      const row555 = { ...trackRow, id: 201, legacy_release_id: 555 };
      const row556 = { ...trackRow, id: 202, legacy_release_id: 556 };
      const row557 = { ...trackRow, id: 203, legacy_release_id: 557 };
      const libraryChain = createMockQueryChain([row555, row556, row557]);
      libraryChain.limit = jest.fn().mockResolvedValue([row555, row556, row557]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });

      const big = await searchLibraryByTrack('Back, Baby', 10);
      expect(big).toHaveLength(3);
      const callsAfterBig = mockLookupBySong.mock.calls.length;

      // Smaller limit on a primed cache — should hit, not re-fetch.
      const small = await searchLibraryByTrack('Back, Baby', 2);

      expect(mockLookupBySong.mock.calls.length).toBe(callsAfterBig);
      expect(small).toHaveLength(2);
      expect(small.map((r) => r.id)).toEqual([201, 202]);
    });

    it('returns a shallow copy so caller mutations do not bleed into the next hit', async () => {
      primeMocks();

      const first = await searchLibraryByTrack('Back, Baby', 10);
      // Mutate the returned array in place.
      first.length = 0;

      const second = await searchLibraryByTrack('Back, Baby', 10);

      // Second hit must still produce the cached result, undisturbed by the
      // first caller's mutation.
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe(101);
    });

    it('different queries hit different cache entries (key isolation)', async () => {
      // Each call needs its own library + CTA chain pair. Use a fresh primeMocks
      // round per call so db.select has chains queued for both invocations.
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      const libraryChainA = createMockQueryChain([trackRow]);
      libraryChainA.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChainA = createMockQueryChain([]);
      ctaChainA.where = jest.fn().mockResolvedValue([]);
      const libraryChainB = createMockQueryChain([trackRow]);
      libraryChainB.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChainB = createMockQueryChain([]);
      ctaChainB.where = jest.fn().mockResolvedValue([]);
      const chains = [libraryChainA, ctaChainA, libraryChainB, ctaChainB];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => chains[Math.min(callIndex++, chains.length - 1)]);

      await searchLibraryByTrack('Back, Baby', 10);
      const callsAfterFirst = mockLookupBySong.mock.calls.length;

      // A different query must re-invoke LML — caches by query, not globally.
      await searchLibraryByTrack('Different Song', 10);

      expect(mockLookupBySong.mock.calls.length).toBe(callsAfterFirst + 1);
      expect(mockLookupBySong).toHaveBeenLastCalledWith('Different Song');
    });

    it('trim + lowercase: variations of the same query share one cache entry', async () => {
      primeMocks();

      await searchLibraryByTrack('  Back, Baby  ', 10);
      const callsAfterFirst = mockLookupBySong.mock.calls.length;

      // Normalized identical: lowercase + trim should collapse to the same key.
      const cached = await searchLibraryByTrack('back, baby', 10);

      expect(mockLookupBySong.mock.calls.length).toBe(callsAfterFirst);
      expect(cached).toHaveLength(1);
      expect(cached[0].id).toBe(101);
    });

    it('flag flip invalidates the cache (same query, different flagStateHash)', async () => {
      // First call: both flags off (default).
      primeMocks();
      await searchLibraryByTrack('Back, Baby', 10);
      const callsAfterFirst = mockLookupBySong.mock.calls.length;

      // Flip the CTA flag and force a config reload. The flag-state hash
      // changes, so the cached entry is keyed under the old hash and the new
      // query must re-fetch from LML.
      process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // Re-prime the mocks so the second call has fresh chain state.
      primeMocks();
      await searchLibraryByTrack('Back, Baby', 10);

      expect(mockLookupBySong.mock.calls.length).toBe(callsAfterFirst + 1);
    });
  });

  describe('searchLibraryByTrack telemetry (Sentry span)', () => {
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
    };
    const lookupItem = {
      library_item: {
        id: 555,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        call_number: 'Rock CD PR 1/2',
        library_url: 'http://www.wxyc.info/wxycdb/libraryRelease?id=555',
      },
      matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs' }],
    };

    function primeMissPath(): void {
      mockLookupBySong.mockResolvedValue({
        results: [lookupItem],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });
      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? libraryChain : ctaChain;
        callIndex += 1;
        return chain;
      });
    }

    beforeEach(() => {
      jest.clearAllMocks();
      __resetTrackSearchCacheForTests();
      // Restore the default span instance so cross-test mockImplementation
      // changes (e.g., the "setAttributes throws" test) don't bleed.
      mockSpanSetAttributes.mockReset();
      mockSpanSetAttribute.mockReset();
    });

    it('wraps the call in a catalog.track_search Sentry span on every invocation', async () => {
      primeMissPath();

      await searchLibraryByTrack('Back, Baby', 10);

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockStartSpan.mock.calls[0][0]).toEqual({
        name: 'searchLibraryByTrack',
        op: 'catalog.track_search',
      });
    });

    it('projects cache_hit=false + master_lookup_ms + latency_ms on a cache miss (LML succeeded)', async () => {
      primeMissPath();

      await searchLibraryByTrack('Back, Baby', 10);

      // cache_hit is emitted as a singular setAttribute call.
      expect(mockSpanSetAttribute).toHaveBeenCalledWith('track_search.cache_hit', false);
      // master_lookup_ms is projected by the inner method via the active span.
      const setAttrsKeys = mockSpanSetAttributes.mock.calls.flatMap((c) => Object.keys(c[0] as object));
      expect(setAttrsKeys).toContain('track_search.master_lookup_ms');
      expect(setAttrsKeys).toContain('track_search.latency_ms');
      // All emitted timing values are finite numbers.
      for (const call of mockSpanSetAttributes.mock.calls) {
        for (const value of Object.values(call[0] as Record<string, unknown>)) {
          expect(typeof value).toBe('number');
          expect(Number.isFinite(value as number)).toBe(true);
        }
      }
    });

    it('projects cache_hit=true + latency_ms on a cache hit (no LML call, no master_lookup_ms)', async () => {
      primeMissPath();
      // Warm the cache.
      await searchLibraryByTrack('Back, Baby', 10);
      mockSpanSetAttribute.mockReset();
      mockSpanSetAttributes.mockReset();
      mockStartSpan.mockClear();
      mockLookupBySong.mockReset();

      // Second call hits the cache.
      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(mockLookupBySong).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockSpanSetAttribute).toHaveBeenCalledWith('track_search.cache_hit', true);
      const setAttrsKeys = mockSpanSetAttributes.mock.calls.flatMap((c) => Object.keys(c[0] as object));
      expect(setAttrsKeys).toContain('track_search.latency_ms');
      // master_lookup_ms is not projected on hit — the inner method never runs.
      expect(setAttrsKeys).not.toContain('track_search.master_lookup_ms');
    });

    it('still projects latency_ms when LML fails (degraded path is still observable)', async () => {
      mockLookupBySong.mockRejectedValue(new Error('LML 502 Bad Gateway'));
      db.select.mockReset();

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(results).toEqual([]);
      const setAttrsKeys = mockSpanSetAttributes.mock.calls.flatMap((c) => Object.keys(c[0] as object));
      expect(setAttrsKeys).toContain('track_search.latency_ms');
    });

    it('resolves successfully when span.setAttributes throws (observability must not break the request path)', async () => {
      primeMissPath();
      mockSpanSetAttributes.mockImplementation(() => {
        throw new Error('sentry boom');
      });

      const results = await searchLibraryByTrack('Back, Baby', 10);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(101);
    });
  });

  describe('isISODate', () => {
    it('returns true for valid ISO date format YYYY-MM-DD', () => {
      expect(isISODate('2024-01-15')).toBe(true);
      expect(isISODate('2000-12-31')).toBe(true);
      expect(isISODate('1999-06-01')).toBe(true);
    });

    it('returns false for invalid formats', () => {
      expect(isISODate('01-15-2024')).toBe(false); // MM-DD-YYYY
      expect(isISODate('15/01/2024')).toBe(false); // DD/MM/YYYY
      expect(isISODate('2024/01/15')).toBe(false); // YYYY/MM/DD
      expect(isISODate('January 15, 2024')).toBe(false);
      expect(isISODate('2024-1-15')).toBe(false); // single digit month
      expect(isISODate('2024-01-5')).toBe(false); // single digit day
    });

    it('returns false for empty or invalid strings', () => {
      expect(isISODate('')).toBe(false);
      expect(isISODate('not-a-date')).toBe(false);
      expect(isISODate('2024')).toBe(false);
      expect(isISODate('2024-01')).toBe(false);
    });

    it('returns true for edge case dates (format only, not validity)', () => {
      // Note: isISODate only checks format, not calendar validity
      expect(isISODate('2024-02-29')).toBe(true); // leap year
      expect(isISODate('2024-02-30')).toBe(true); // invalid day but correct format
      expect(isISODate('2024-13-01')).toBe(true); // invalid month but correct format
    });
  });

  describe('getAlbumFromDB', () => {
    it('returns album with format_name, genre_name, date_lost, date_found, on_streaming, and nested reconciled_identity', async () => {
      const mockAlbum = {
        id: 42,
        code_letters: 'AU',
        code_artist_number: 1,
        code_number: 3,
        artist_name: 'Autechre',
        alphabetical_name: 'Autechre',
        album_title: 'Confield',
        record_label: 'Warp',
        label_id: 10,
        plays: 5,
        add_date: new Date('2024-01-15'),
        last_modified: new Date('2024-03-01'),
        format_name: 'CD',
        genre_name: 'Electronic',
        date_lost: null,
        date_found: null,
        on_streaming: true,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };
      const chain = createMockQueryChain([mockAlbum]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockAlbum]);

      const result = await getAlbumFromDB(42);

      expect(result).toHaveProperty('format_name', 'CD');
      expect(result).toHaveProperty('genre_name', 'Electronic');
      expect(result).toHaveProperty('date_lost', null);
      expect(result).toHaveProperty('date_found', null);
      expect(result).toHaveProperty('on_streaming', true);
      expect(result).toHaveProperty('reconciled_identity', null);
      // The flat external-ID columns are stripped from the wire shape.
      expect(result).not.toHaveProperty('discogs_artist_id');
      expect(result).not.toHaveProperty('musicbrainz_artist_id');
      expect(db.select).toHaveBeenCalled();
    });

    it('returns undefined when album not found', async () => {
      const chain = createMockQueryChain([]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([]);

      const result = await getAlbumFromDB(999);

      expect(result).toBeUndefined();
    });
  });

  describe('markAlbumMissing', () => {
    it('issues UPDATE and returns the updated row ID', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42 }]);

      const result = await markAlbumMissing(42);

      expect(result).toEqual({ id: 42 });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns undefined when album does not exist', async () => {
      const chain = createMockQueryChain([]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await markAlbumMissing(999);

      expect(result).toBeUndefined();
    });
  });

  describe('markAlbumFound', () => {
    it('issues UPDATE and returns the updated row ID', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42 }]);

      const result = await markAlbumFound(42);

      expect(result).toEqual({ id: 42 });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns undefined when album does not exist', async () => {
      const chain = createMockQueryChain([]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await markAlbumFound(999);

      expect(result).toBeUndefined();
    });
  });

  describe('updateArtworkUrl', () => {
    it('updates the artwork_url column and returns the updated row when current value is NULL', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42, artwork_url: 'https://i.discogs.com/confield.jpg' }]);

      const result = await updateArtworkUrl(42, 'https://i.discogs.com/confield.jpg');

      expect(result).toEqual({ id: 42, artwork_url: 'https://i.discogs.com/confield.jpg' });
      expect(db.update).toHaveBeenCalled();
    });

    it('narrows the UPDATE WHERE by id AND artwork_url IS NULL (race guard, #718)', async () => {
      // The mocked `chain.where` is a self-returning stub — it doesn't
      // actually filter — so a returning() of [] alone wouldn't catch a
      // future revert that drops the narrowing predicate. Capture the SQL
      // expression passed to `.where(...)` and assert it composes both
      // operands. The drizzle-orm auto-mock at tests/__mocks__/drizzle-orm.ts
      // makes `and(a, b)` return `{ and: [a, b] }`, `eq(c, v)` return
      // `{ eq: [c, v] }`, and `isNull(c)` return `{ isNull: c }` — so a
      // direct structural assertion suffices and a regression that swaps
      // `and(eq(...), isNull(...))` back to `eq(...)` alone would no longer
      // produce the same shape.
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await updateArtworkUrl(42, 'https://i.discogs.com/confield.jpg');

      expect(result).toBeUndefined();
      expect(chain.where).toHaveBeenCalledTimes(1);

      const whereArg = chain.where.mock.calls[0]?.[0] as { and?: unknown[] };
      expect(whereArg).toEqual({
        and: [{ eq: ['id', 42] }, { isNull: 'artwork_url' }],
      });
    });
  });

  describe('enrichWithArtwork', () => {
    beforeEach(() => {
      mockIsLmlConfigured.mockReturnValue(true);
    });

    it('returns results unchanged when LML is not configured', async () => {
      mockIsLmlConfigured.mockReturnValue(false);
      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('returns results unchanged when all have artwork cached', async () => {
      const results = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: 'https://i.discogs.com/confield.jpg' },
        {
          id: 2,
          artist_name: 'Stereolab',
          album_title: 'Aluminum Tunes',
          artwork_url: 'https://i.discogs.com/aluminum.jpg',
        },
      ];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('fetches artwork from LML for uncached results and caches to DB', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 1 }]);

      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'Confield',
              artist: 'Autechre',
              call_number: 'Electronic CD AUT 1/1',
              library_url: '',
            },
            artwork: {
              release_id: 12345,
              release_url: 'https://www.discogs.com/release/12345',
              artwork_url: 'https://i.discogs.com/confield.jpg',
              confidence: 0.95,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBe('https://i.discogs.com/confield.jpg');
      expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield');
      expect(db.update).toHaveBeenCalled();
    });

    it('filters spacer.gif artwork URLs', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'Unknown',
              artist: 'Unknown',
              call_number: 'Rock CD UNK 1/1',
              library_url: '',
            },
            artwork: {
              release_id: 99999,
              release_url: 'https://www.discogs.com/release/99999',
              artwork_url: 'https://st.discogs.com/images/spacer.gif',
              confidence: 0.5,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [{ id: 1, artist_name: 'Unknown Artist', album_title: 'Unknown Album', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('handles LML failure gracefully without throwing', async () => {
      mockLookupMetadata.mockRejectedValue(new Error('LML timeout'));

      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(enriched[0].artwork_url).toBeNull();
    });

    it('does not overwrite existing cached artwork', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 2 }]);

      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 2,
              title: 'LP5',
              artist: 'Autechre',
              call_number: 'Electronic CD AUT 2/1',
              library_url: '',
            },
            artwork: {
              release_id: 67890,
              release_url: 'https://www.discogs.com/release/67890',
              artwork_url: 'https://i.discogs.com/lp5.jpg',
              confidence: 0.9,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: 'https://i.discogs.com/confield.jpg' },
        { id: 2, artist_name: 'Autechre', album_title: 'LP5', artwork_url: null },
      ];

      const enriched = await enrichWithArtwork(results);

      // Cached result unchanged
      expect(enriched[0].artwork_url).toBe('https://i.discogs.com/confield.jpg');
      // Uncached result enriched
      expect(enriched[1].artwork_url).toBe('https://i.discogs.com/lp5.jpg');
      // Only one LML call (for LP5, not Confield)
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
      expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'LP5');
    });

    it('handles LML returning no results', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [],
        search_type: 'none',
        found_on_compilation: false,
        song_not_found: false,
      });

      const results = [{ id: 1, artist_name: 'Obscure Artist', album_title: 'Rare Album', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('searchLibraryByCTA', () => {
    const mockCTARow = {
      id: 11,
      code_letters: 'VA',
      code_artist_number: 1,
      code_number: 5,
      artist_name: 'Various Artists',
      alphabetical_name: 'Various Artists',
      album_title: 'Edits',
      format_name: 'cd',
      genre_name: 'Electronic',
      rotation_bin: null,
      add_date: new Date('2024-01-15'),
      label: 'self-released',
      label_id: null,
      on_streaming: true,
      album_artist: null,
      plays: 0,
      artwork_url: null,
      discogs_artist_id: null,
      musicbrainz_artist_id: null,
      wikidata_qid: null,
      spotify_artist_id: null,
      apple_music_artist_id: null,
      bandcamp_id: null,
      cta_track_title: 'Call Your Name',
      cta_artist_name: 'Chuquimamani-Condori',
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns enriched results with a cta-source TrackMatchHint on track_title match', async () => {
      db.execute.mockResolvedValue([mockCTARow]);

      const results = await searchLibraryByCTA('Call Your Name', 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(11);
      expect(results[0].artist).toBe('Various Artists');
      expect(results[0].matched_via).toEqual([
        {
          title: 'Call Your Name',
          artist_credit: 'Chuquimamani-Condori',
          source: 'cta',
          confidence: 1.0,
        },
      ]);
    });

    it('returns enriched results with a cta-source TrackMatchHint on artist_name match', async () => {
      db.execute.mockResolvedValue([mockCTARow]);

      const results = await searchLibraryByCTA('Chuquimamani', 5);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via?.[0].artist_credit).toBe('Chuquimamani-Condori');
      expect(results[0].matched_via?.[0].source).toBe('cta');
      expect(results[0].matched_via?.[0].confidence).toBe(1.0);
    });

    it('returns an empty array when no rows match', async () => {
      db.execute.mockResolvedValue([]);

      const results = await searchLibraryByCTA('zzz no match zzz', 5);

      expect(results).toEqual([]);
    });

    it('returns an empty array without a DB call for an empty / whitespace-only query', async () => {
      const results = await searchLibraryByCTA('   ', 5);

      expect(results).toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('returns an empty array without a DB call for pure-punctuation queries', async () => {
      const results = await searchLibraryByCTA('!!!', 5);

      expect(results).toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('groups multiple CTA matches against the same library row into one result with multiple hints', async () => {
      const secondHintRow = {
        ...mockCTARow,
        cta_track_title: 'Another Track',
        cta_artist_name: 'Chuquimamani-Condori',
      };
      db.execute.mockResolvedValue([mockCTARow, secondHintRow]);

      const results = await searchLibraryByCTA('Chuquimamani', 5);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via).toHaveLength(2);
      expect(results[0].matched_via?.map((h) => h.title)).toEqual(['Call Your Name', 'Another Track']);
    });

    it('threads on_streaming=true into the SQL predicate', async () => {
      db.execute.mockResolvedValue([mockCTARow]);

      await searchLibraryByCTA('Chuquimamani', 5, true);

      expect(db.execute).toHaveBeenCalledTimes(1);
      // The drizzle-orm auto-mock (tests/__mocks__/drizzle-orm.ts) makes each
      // tagged-template `sql\`...\`` return `{ sql, values }`; nested sql
      // fragments appear as objects inside the parent's `values` array.
      // Flatten the tree before asserting on the interpolated `on_streaming`
      // value.
      const sqlArg = db.execute.mock.calls[0]?.[0];
      expect(flattenSqlValues(sqlArg)).toContain(true);
    });

    it('omits the on_streaming filter when the arg is undefined', async () => {
      db.execute.mockResolvedValue([mockCTARow]);

      await searchLibraryByCTA('Chuquimamani', 5);

      const sqlArg = db.execute.mock.calls[0]?.[0];
      const flattened = flattenSqlValues(sqlArg);
      // No streaming filter, so neither `true` nor `false` should appear
      // in the SQL values.
      expect(flattened).not.toContain(true);
      expect(flattened).not.toContain(false);
    });
  });
});
