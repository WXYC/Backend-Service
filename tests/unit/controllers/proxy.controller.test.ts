/**
 * Unit tests for the proxy controller.
 *
 * Handlers that are rerouted through library-metadata-lookup (LML) mock the
 * LML client. The Spotify handler still mocks global fetch directly.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
// Type-only: erased at compile time, so this is safe alongside the
// jest.mock(...) of the same module's runtime exports below (BS#1827).
import type { LinkedFlowsheetRow } from '../../../apps/backend/services/album-metadata-lookup.service';

// --- Mocks ---

// LML client mocks (used by searchArtwork, getAlbumMetadata, getArtistMetadata, resolveEntity)
const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockGetRelease = jest.fn<() => Promise<unknown>>();
const mockGetArtistDetails = jest.fn<() => Promise<unknown>>();
const mockResolveEntity = jest.fn<() => Promise<unknown>>();
const mockSearchLibrary = jest.fn<() => Promise<unknown>>();

class MockLmlClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LmlClientError';
    this.statusCode = statusCode;
  }
}

jest.mock('@wxyc/lml-client', () => {
  // BS#1714: buildLocalMetadataResponse now host-guards the persisted
  // spotify_url/apple_music_url via these predicates. Pass the REAL
  // (side-effect-free, type-only-dep) implementations through from the guard
  // submodule so the suppression behaves exactly as in production — requiring
  // the whole `@wxyc/lml-client` index would needlessly load Sentry + the HTTP
  // client the rest of this factory deliberately stubs.
  const { isSpotifyUrl, isAppleMusicUrl } = jest.requireActual<
    typeof import('../../../shared/lml-client/src/streaming-url-guard')
  >('../../../shared/lml-client/src/streaming-url-guard');
  return {
    lookupMetadata: mockLookupMetadata,
    getRelease: mockGetRelease,
    getArtistDetails: mockGetArtistDetails,
    resolveEntity: mockResolveEntity,
    searchLibrary: mockSearchLibrary,
    envInt: (_name: string, fallback: number) => fallback,
    isSpotifyUrl,
    isAppleMusicUrl,
    LmlClientError: MockLmlClientError,
  };
});

// Backend code paths now route through the LmlLookupCoordinator (BS#885).
jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: mockLookupMetadata },
}));

// BS#1331 + ADR 0012 + BS#1827: getAlbumMetadata resolves the linked flowsheet
// row ONCE via `selectLinkedFlowsheetRow` (album_id + the base catalog fields
// off the SAME row), then feeds the album_id to the by-id persisted-metadata
// read (`lookupAlbumMetadataById`) and — flag-gated — the by-id critic-reviews
// read (`lookupCriticReviewsByAlbumId`). Resolving once makes the base fields,
// album_id, metadata, and reviews all describe the same row atomically — a
// two-query version (album_id then a separate base-fields lookup) could let a
// concurrent flowsheet insert land between the two calls and describe two
// different rows for one request. Each mock lets a test drive its slice of
// the contract independently.
const mockSelectLinkedFlowsheetRow =
  jest.fn<(artist: string, release?: string) => Promise<LinkedFlowsheetRow | null>>();
const mockLookupAlbumMetadataById = jest.fn<(albumId: number) => Promise<unknown>>();
const mockLookupCriticReviewsByAlbumId = jest.fn<(albumId: number) => Promise<unknown[]>>();
jest.mock('../../../apps/backend/services/album-metadata-lookup.service', () => ({
  selectLinkedFlowsheetRow: mockSelectLinkedFlowsheetRow,
  lookupAlbumMetadataById: mockLookupAlbumMetadataById,
  lookupCriticReviewsByAlbumId: mockLookupCriticReviewsByAlbumId,
}));

// Default album_id the resolve step returns across getAlbumMetadata tests so
// both the by-id metadata read and the (flag-gated) reviews read are reachable.
// Tests that assert the cold/local-hit metadata shape control it via the by-id
// mock's resolved value; the resolved id itself only matters where a test pins
// the call argument.
const DEFAULT_LINKED_ALBUM_ID = 4242;

// Default linked-row fixture (BS#1827): album_id resolves but no base catalog
// fields are known — the pre-existing "cold" cohort every test predating
// BS#1827 already assumed. Individual base-field tests override this.
const defaultLinkedRow = (): LinkedFlowsheetRow => ({
  album_id: DEFAULT_LINKED_ALBUM_ID,
  record_label: null,
  label_id: null,
  metadata_status: 'pending',
});

// ADR 0012 flag: getConfig().enabled gates the criticReviews attach. Default
// off (matches prod) so unrelated getAlbumMetadata tests keep their exact
// response shapes; the critic-reviews suite opts in per test.
const mockCriticReviewsConfig = jest.fn<() => { enabled: boolean }>(() => ({ enabled: false }));
jest.mock('../../../apps/backend/config/criticReviews', () => ({
  getConfig: mockCriticReviewsConfig,
}));

// BS#1331 acceptance: the cohort split for trace explorer turns on
// `proxy.metadata.album.upstream_calls`. Override only `getActiveSpan`
// from the real `@sentry/node` module so the cache-first test can assert
// the attribute lands as a number; outside a tracing context the real
// `getActiveSpan()` is null and the call short-circuits. Preserving the
// rest of the module surface lets future controller hardening (e.g.
// `Sentry.captureException` on the cache-first DB-error catch arm)
// continue to load without a confusing "X is not a function" TypeError
// far from the change site.
const mockSpanSetAttributes = jest.fn();
const mockGetActiveSpan = jest.fn(() => ({ setAttributes: mockSpanSetAttributes }));
jest.mock('@sentry/node', () => ({
  ...jest.requireActual<object>('@sentry/node'),
  getActiveSpan: mockGetActiveSpan,
}));

// library.service mock — only the helper libraryTracks consumes
// getDiscogsReleaseIdByLegacyId. BS#1895: getAlbumMetadata also resolves
// getDiscogsUnavailableFlagsById(albumId) — defaults to `undefined` (no
// library row found), matching every pre-#1895 test's assumption that the
// response shape excludes discogsUnavailable unless a test opts in.
const mockGetDiscogsReleaseIdByLegacyId = jest.fn<(legacyId: number) => Promise<number | null>>();
const mockGetDiscogsUnavailableFlagsById = jest.fn<
  (
    albumId: number
  ) => Promise<
    | { discogsUnavailable: boolean; discogsUnavailableNote: string | null; lastDiscogsRecheckAt: Date | null }
    | undefined
  >
>(() => Promise.resolve(undefined));

jest.mock('../../../apps/backend/services/library.service', () => ({
  getDiscogsReleaseIdByLegacyId: mockGetDiscogsReleaseIdByLegacyId,
  getDiscogsUnavailableFlagsById: mockGetDiscogsUnavailableFlagsById,
}));

// Artwork finder mock (still used for Last.fm/iTunes fallback in searchArtwork)
const mockFind = jest.fn<
  () => Promise<{
    artworkUrl: string | null;
    releaseUrl: string | null;
    album: string | null;
    artist: string | null;
    source: string | null;
    confidence: number;
  }>
>();

jest.mock('../../../apps/backend/services/artwork/finder', () => ({
  getArtworkFinder: () => ({ find: mockFind }),
}));

// LRU cache mock (proxy controller uses it for artwork caching).
//
// Note (BS#1089): this monorepo has a *second*, nested `lru-cache` install
// under `apps/backend/node_modules/` (separate from the hoisted root copy),
// so `proxy.controller.ts`'s `import { LRUCache } from 'lru-cache'` resolves
// to a different physical module than this `jest.mock('lru-cache', ...)`
// call does from this file's location — the mock below is never actually
// substituted into proxy.controller.ts, which runs against the real
// `lru-cache` package. That's harmless for the tests that only depend on a
// cache starting empty, but it means the negative-cache tests below can't
// assert on a mocked `.set`/`.has` — they instead assert on the REAL cache's
// observable behavior (does a follow-up request re-hit the finder or not).
jest.mock('lru-cache', () => ({
  LRUCache: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn(),
    has: jest.fn().mockReturnValue(false),
  })),
}));

const mockClassifyNSFW = jest.fn<() => Promise<'sfw' | 'nsfw'>>();

jest.mock('../../../apps/backend/services/artwork/nsfw', () => ({
  classify: mockClassifyNSFW,
}));

// Mock global fetch for image downloads and Spotify track endpoint
const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import {
  searchArtwork,
  getAlbumMetadata,
  getArtistMetadata,
  resolveEntity,
  getSpotifyTrack,
  librarySearch,
  libraryTracks,
  __resetLibraryTracksCacheForTests,
  __resetAlbumMetadataCacheForTests,
  __resetArtistMetadataCacheForTests,
  __resetEntityResolveCacheForTests,
  __getEntityResolveRemainingTtlForTests,
  __resetSpotifyTrackCacheForTests,
  __resetArtworkCacheForTests,
  __resetNegativeCacheForTests,
} from '../../../apps/backend/controllers/proxy.controller';

// --- Helpers ---

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.send = jest.fn().mockReturnValue(res) as unknown as Response['send'];
  res.set = jest.fn().mockReturnValue(res) as unknown as Response['set'];
  return res;
};

describe('proxy.controller', () => {
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn();
    // Flag defaults off every test (clearAllMocks clears calls, not a
    // mockReturnValue set by a prior test) so unrelated getAlbumMetadata
    // assertions never see a leaked criticReviews attach.
    mockCriticReviewsConfig.mockReturnValue({ enabled: false });
  });

  // --- searchArtwork ---

  describe('searchArtwork', () => {
    it('throws WxycError 400 when artistName is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await expect(searchArtwork(req, res as Response, mockNext)).rejects.toThrow(
        'artistName query parameter is required'
      );
    });

    it('returns SFW image bytes with content type and cache header', async () => {
      const imageBytes = Buffer.from('fake-image-data');

      mockFind.mockResolvedValue({
        artworkUrl: 'https://i.discogs.com/img.jpg',
        releaseUrl: 'https://discogs.com/release/123',
        album: 'Confield',
        artist: 'Autechre',
        source: 'discogs',
        confidence: 0.95,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBytes.buffer),
        headers: new Headers({ 'content-type': 'image/jpeg' }),
      } as unknown as globalThis.Response);

      mockClassifyNSFW.mockResolvedValue('sfw');

      const req = { query: { artistName: 'Autechre', releaseTitle: 'Confield' } } as unknown as Request;
      const res = createMockRes();

      await searchArtwork(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalled();
      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('returns 404 when artwork is NSFW', async () => {
      const imageBytes = Buffer.from('nsfw-image-data');

      mockFind.mockResolvedValue({
        artworkUrl: 'https://i.discogs.com/nsfw.jpg',
        releaseUrl: null,
        album: 'NSFW Album',
        artist: 'Some Artist',
        source: 'discogs',
        confidence: 0.9,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBytes.buffer),
        headers: new Headers({ 'content-type': 'image/jpeg' }),
      } as unknown as globalThis.Response);

      mockClassifyNSFW.mockResolvedValue('nsfw');

      const req = { query: { artistName: 'Some Artist', releaseTitle: 'NSFW Album' } } as unknown as Request;
      const res = createMockRes();

      await searchArtwork(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 404 when no artwork URL is found', async () => {
      mockFind.mockResolvedValue({
        artworkUrl: null,
        releaseUrl: null,
        album: null,
        artist: null,
        source: null,
        confidence: 0,
      });

      const req = { query: { artistName: 'Unknown Artist' } } as unknown as Request;
      const res = createMockRes();

      await searchArtwork(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('rejects with error on service failure', async () => {
      const error = new Error('Service failure');
      mockFind.mockRejectedValue(error);

      const req = { query: { artistName: 'Test' } } as unknown as Request;
      const res = createMockRes();

      await expect(searchArtwork(req, res as Response, mockNext)).rejects.toThrow(error);
    });

    // --- BS#1089: negative-cache must not conflate a transient upstream
    // error with a confirmed "no artwork" result. `artworkCache`/
    // `negativeCache` are real module-level LRU singletons here (see the
    // `jest.mock('lru-cache', ...)` note above — it isn't actually wired
    // into proxy.controller.ts in this monorepo layout), so these tests
    // assert on the cache's real, observable effect on a follow-up request
    // rather than on a mocked `.set` call. Each test uses an artist/release
    // pair not used by any other `searchArtwork` test in this file, since
    // the cache persists across tests within this run.

    it('does not negative-cache a transient upstream failure: returns 502, and a follow-up request re-attempts the lookup', async () => {
      // Mirrors ArtworkFinder.find's `errored: true` tag: every provider
      // came back empty because it threw (e.g. an LML timeout), not because
      // it confirmed there's no artwork. A negative-cache write here would
      // strand this key as "no artwork" for the full 24h TTL even after LML
      // recovers — proven below by a second, identical request re-hitting
      // the finder instead of short-circuiting to a cached 404.
      //
      // `mockReset()` (not just the outer `beforeEach`'s `clearAllMocks()`)
      // because `clearMocks`/`clearAllMocks` don't drain a queued-but-
      // unconsumed `mockResolvedValueOnce` — if this test's second call
      // never reaches the finder (the bug this test guards against), that
      // second queued value would otherwise leak into the next test.
      mockFind.mockReset();
      mockFind.mockResolvedValueOnce({
        artworkUrl: null,
        releaseUrl: null,
        album: null,
        artist: null,
        source: null,
        confidence: 0,
        errored: true,
      });
      mockFind.mockResolvedValueOnce({
        artworkUrl: 'https://i.discogs.com/edits.jpg',
        releaseUrl: 'https://discogs.com/release/1',
        album: 'Edits',
        artist: 'Chuquimamani-Condori',
        source: 'discogs',
        confidence: 0.9,
      });
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('img').buffer),
        headers: new Headers({ 'content-type': 'image/jpeg' }),
      } as unknown as globalThis.Response);
      mockClassifyNSFW.mockResolvedValue('sfw');

      const req = { query: { artistName: 'Chuquimamani-Condori', releaseTitle: 'Edits' } } as unknown as Request;

      const firstRes = createMockRes();
      await searchArtwork(req, firstRes as Response, mockNext);
      expect(firstRes.status).toHaveBeenCalledWith(502);

      const secondRes = createMockRes();
      await searchArtwork(req, secondRes as Response, mockNext);

      // Nothing was cached, so the second request re-consults the finder
      // (and this time gets a real match) instead of short-circuiting.
      expect(mockFind).toHaveBeenCalledTimes(2);
      expect(secondRes.status).toHaveBeenCalledWith(200);
    });

    it('negative-caches a confirmed absence: returns 404, and a follow-up request short-circuits without re-invoking the finder', async () => {
      // Every provider ran to completion and confirmed no match — this IS
      // the legitimate negative-cache case (albums genuinely absent from
      // Discogs), so a subsequent identical request should be served from
      // the cache rather than re-attempting the lookup for the rest of the
      // TTL.
      //
      // `mockReset()` for the same reason as the previous test — guards
      // against a queued-but-unconsumed `mockResolvedValueOnce` leaking in
      // from a prior test (`clearMocks` doesn't drain that queue).
      mockFind.mockReset();
      mockFind.mockResolvedValueOnce({
        artworkUrl: null,
        releaseUrl: null,
        album: null,
        artist: null,
        source: null,
        confidence: 0,
        errored: false,
      });
      // If the second request reached the finder again, this would resolve
      // to a real match — the assertion below proves it never does.
      mockFind.mockResolvedValueOnce({
        artworkUrl: 'https://i.discogs.com/obscure.jpg',
        releaseUrl: 'https://discogs.com/release/2',
        album: 'Obscure Album',
        artist: 'Obscure Artist',
        source: 'discogs',
        confidence: 0.9,
      });

      const req = { query: { artistName: 'Obscure Artist', releaseTitle: 'Obscure Album' } } as unknown as Request;

      const firstRes = createMockRes();
      await searchArtwork(req, firstRes as Response, mockNext);
      expect(firstRes.status).toHaveBeenCalledWith(404);

      const secondRes = createMockRes();
      await searchArtwork(req, secondRes as Response, mockNext);

      expect(mockFind).toHaveBeenCalledTimes(1);
      expect(secondRes.status).toHaveBeenCalledWith(404);
    });

    // BS#989: `artworkCache`/`negativeCache` chokepoint cache-stats
    // projection. Reset both caches first (new test-only hooks, mirroring
    // every other proxy cache) so `cache_size` is deterministic — the rest
    // of this describe block deliberately reuses the module-level singleton
    // across tests via unique artist/release names (see the comment above),
    // so a shared reset here would only affect tests that run after it.
    describe('cache-stats projection (BS#989)', () => {
      beforeEach(() => {
        __resetArtworkCacheForTests();
        __resetNegativeCacheForTests();
      });

      it('projects cache_name="artwork" onto the Sentry span for the positive-artwork path', async () => {
        mockFind.mockResolvedValue({
          artworkUrl: 'https://i.discogs.com/cache-stats.jpg',
          releaseUrl: 'https://discogs.com/release/cache-stats',
          album: 'Cache Stats Album',
          artist: 'Cache Stats Artist',
          source: 'discogs',
          confidence: 0.95,
        });
        mockFetch.mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(Buffer.from('img').buffer),
          headers: new Headers({ 'content-type': 'image/jpeg' }),
        } as unknown as globalThis.Response);
        mockClassifyNSFW.mockResolvedValue('sfw');

        const req = {
          query: { artistName: 'Cache Stats Artist', releaseTitle: 'Cache Stats Album' },
        } as unknown as Request;

        await searchArtwork(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: false,
          cache_name: 'artwork',
          cache_size: 1,
          cache_capacity: 200,
        });

        await searchArtwork(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: true,
          cache_name: 'artwork',
          cache_size: 1,
          cache_capacity: 200,
        });
      });

      it('projects cache_name="negative" onto the Sentry span for the confirmed-absence path', async () => {
        mockFind.mockResolvedValue({
          artworkUrl: null,
          releaseUrl: null,
          album: null,
          artist: null,
          source: null,
          confidence: 0,
          errored: false,
        });

        const req = {
          query: { artistName: 'Cache Stats Negative Artist', releaseTitle: 'Cache Stats Negative Album' },
        } as unknown as Request;

        await searchArtwork(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: false,
          cache_name: 'negative',
          cache_size: 1,
          cache_capacity: 1000,
        });

        await searchArtwork(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: true,
          cache_name: 'negative',
          cache_size: 1,
          cache_capacity: 1000,
        });
      });
    });
  });

  // --- getAlbumMetadata ---

  describe('getAlbumMetadata', () => {
    beforeEach(() => {
      // Default: a linked album_id resolves (so the reviews attach is
      // reachable) but no persisted metadata row exists — the cold case, so
      // existing tests fall through to LML. Local-hit tests override the by-id
      // metadata mock below. No base catalog fields on the default row either
      // (inert — existing tests predate BS#1827 and assert nothing about
      // recordLabel/labelId/metadataStatus; the base-field-survival suite
      // below overrides this per test). `clearAllMocks` clears calls, not the
      // resolved value a prior test set, so the default is re-asserted here.
      // BS#1331 / BS#1827.
      mockSelectLinkedFlowsheetRow.mockResolvedValue(defaultLinkedRow());
      mockLookupAlbumMetadataById.mockResolvedValue(null);
      // BS#988: this suite reuses artist/release names across many
      // independent `it()`s (e.g. "Autechre"/"Confield", "Jessica Pratt"/"On
      // Your Own Love Again"). Without a reset, the new response cache
      // introduced by BS#988 would make a later test's identical request
      // silently short-circuit to an earlier test's cached response instead
      // of exercising its own mocks — reset before every test so each one
      // starts cold, same discipline as `__resetLibraryTracksCacheForTests`
      // below in the `libraryTracks` suite.
      __resetAlbumMetadataCacheForTests();
    });

    // BS#1893: don't memoize a non-terminal (pending/enriching) album snapshot —
    // its enrichment lands seconds later via the CDC worker, and a 1h-cached
    // pending snapshot would mask that freshness on this path. The lru-cache mock
    // isn't wired into the controller (nested install; see the mock note up top),
    // so these assert the REAL cache's observable effect: does a repeat request
    // re-resolve the linked row, or short-circuit on a cached response?
    describe('non-terminal metadata_status caching (BS#1893)', () => {
      it('does not cache a pending album snapshot: a repeat request re-resolves instead of serving stale pending', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: null,
          label_id: null,
          metadata_status: 'pending',
        });
        mockLookupAlbumMetadataById.mockResolvedValue(null); // no album_metadata row yet
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = { query: { artistName: 'Pending Artist', releaseTitle: 'Pending Album' } } as unknown as Request;
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);

        // Not cached → the second request re-resolves the linked row.
        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledTimes(2);
      });

      it('caches a terminal (enriched_match) album snapshot: a repeat request short-circuits without re-resolving', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: null,
          label_id: null,
          metadata_status: 'enriched_match',
        });
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: 'https://i.discogs.com/enriched.jpg',
          discogs_url: 'https://www.discogs.com/release/1',
          release_year: 2020,
        });

        const req = { query: { artistName: 'Enriched Artist', releaseTitle: 'Enriched Album' } } as unknown as Request;
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);

        // Cached (a terminal, stable snapshot) → the second request is served
        // from the response cache and never re-resolves. Also exercises the new
        // `sizeCalculation`/`maxSize` write path (BS#1893) end to end.
        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledTimes(1);
      });
    });

    // ADR 0012: attach external critic-review snippets, flag-gated. These run
    // in the cold-case default (persisted=null, LML returns nothing); the
    // attach happens after both the local-hit and cold branches, so the
    // cohort is irrelevant to the attach behavior.
    describe('criticReviews attach (ADR 0012)', () => {
      const sampleReviews = [
        {
          source: 'The Quietus',
          url: 'https://thequietus.com/articles/example',
          snippet: 'A record that dissolves song into texture.',
        },
      ];

      it('flag off (default): never calls the reviews lookup and omits criticReviews', async () => {
        // Even with the lookup primed to return snippets, the flag gate must
        // keep the response byte-identical to before — the #32 freeze-safety
        // invariant.
        mockLookupCriticReviewsByAlbumId.mockResolvedValue(sampleReviews);
        const req = { query: { artistName: 'Juana Molina', releaseTitle: 'DOGA' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupCriticReviewsByAlbumId).not.toHaveBeenCalled();
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result).not.toHaveProperty('criticReviews');
      });

      it('flag on + non-empty: attaches criticReviews', async () => {
        mockCriticReviewsConfig.mockReturnValue({ enabled: true });
        mockLookupCriticReviewsByAlbumId.mockResolvedValue(sampleReviews);
        const req = { query: { artistName: 'Juana Molina', releaseTitle: 'DOGA' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        // Reviews are read by the resolved album_id, not by artist/release —
        // the resolve happened once and both reads observe the same id.
        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledWith('Juana Molina', 'DOGA');
        expect(mockLookupCriticReviewsByAlbumId).toHaveBeenCalledWith(DEFAULT_LINKED_ALBUM_ID);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.criticReviews).toEqual(sampleReviews);
      });

      it('flag on + empty result: omits criticReviews so an un-seeded album is byte-identical', async () => {
        mockCriticReviewsConfig.mockReturnValue({ enabled: true });
        mockLookupCriticReviewsByAlbumId.mockResolvedValue([]);
        const req = { query: { artistName: 'Unseeded', releaseTitle: 'Album' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result).not.toHaveProperty('criticReviews');
      });

      it('flag on + lookup throws: degrades to omitting criticReviews, still responds 200', async () => {
        mockCriticReviewsConfig.mockReturnValue({ enabled: true });
        mockLookupCriticReviewsByAlbumId.mockRejectedValue(new Error('db down'));
        const req = { query: { artistName: 'Any', releaseTitle: 'Album' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result).not.toHaveProperty('criticReviews');
      });
    });

    // BS#1895 (Not-on-Discogs epic #1280 sub-issue 5): iOS reads this
    // handler for playcut-detail metadata (the surface behind
    // `PlaylistEntry.artworkURL`), so the MD-set flag needs to reach it too.
    // `discogs_unavailable` lives on `library`, not `album_metadata`, so this
    // is a dedicated lookup keyed on the same resolved `album_id` critic
    // reviews uses — same additive-failure and gating contract.
    describe('discogsUnavailable attach (BS#1895)', () => {
      it('a flagged album: attaches discogsUnavailable: true and its note', async () => {
        mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce({
          discogsUnavailable: true,
          discogsUnavailableNote: 'Embargoed promo, MD-confirmed',
          lastDiscogsRecheckAt: null,
        });
        const req = { query: { artistName: 'Juana Molina', releaseTitle: 'DOGA' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledWith(DEFAULT_LINKED_ALBUM_ID);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.discogsUnavailable).toBe(true);
        expect(result.discogsUnavailableNote).toBe('Embargoed promo, MD-confirmed');
      });

      it('an unflagged album: attaches discogsUnavailable: false, not omitted', async () => {
        mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce({
          discogsUnavailable: false,
          discogsUnavailableNote: null,
          lastDiscogsRecheckAt: null,
        });
        const req = { query: { artistName: 'Juana Molina', releaseTitle: 'DOGA' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result).toHaveProperty('discogsUnavailable', false);
        expect(result).not.toHaveProperty('discogsUnavailableNote');
      });

      it('no library row for the resolved album_id: omits discogsUnavailable entirely', async () => {
        mockGetDiscogsUnavailableFlagsById.mockResolvedValue(undefined);
        const req = { query: { artistName: 'Unseeded', releaseTitle: 'Album' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result).not.toHaveProperty('discogsUnavailable');
      });

      it('lookup throws: degrades to omitting discogsUnavailable, still responds 200', async () => {
        // `mockRejectedValueOnce` (not the persistent `mockRejectedValue`):
        // this lookup runs unconditionally whenever albumId resolves (no
        // flag gate, unlike criticReviews), so a persistent rejection would
        // leak into every later test in this file that doesn't explicitly
        // re-arm the mock — including the cache tests below, which assert
        // exact call counts.
        mockGetDiscogsUnavailableFlagsById.mockRejectedValueOnce(new Error('db down'));
        const req = { query: { artistName: 'Any', releaseTitle: 'Album' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result).not.toHaveProperty('discogsUnavailable');
      });

      it('no linked album_id: never calls the lookup', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        const req = { query: { artistName: 'Freetext Only', releaseTitle: 'Never Linked' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockGetDiscogsUnavailableFlagsById).not.toHaveBeenCalled();
      });
    });

    it('throws WxycError 400 when artistName is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await expect(getAlbumMetadata(req, res as Response, mockNext)).rejects.toThrow(
        'artistName query parameter is required'
      );
    });

    it('returns merged metadata from LML lookup + release details', async () => {
      // Post-BS#885: the coordinator forces `extended: true` on every
      // lookup, so the artwork block carries the release-detail fields
      // (year/label/genres/styles/tracklist/discogs_artist_id/released)
      // inline. No separate `getRelease()` call.
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
              artwork_url: 'https://i.discogs.com/art.jpg',
              album: 'Confield',
              artist: 'Autechre',
              confidence: 0.95,
              spotify_url: 'https://open.spotify.com/album/abc',
              apple_music_url: 'https://music.apple.com/album/xyz',
              youtube_music_url: 'https://music.youtube.com/search?q=Autechre+Confield',
              bandcamp_url: 'https://bandcamp.com/search?q=Autechre+Confield',
              soundcloud_url: 'https://soundcloud.com/search?q=Autechre+Confield',
              release_year: 2001,
              label: 'Warp',
              discogs_artist_id: 3840,
              genres: ['Electronic'],
              styles: ['IDM', 'Abstract'],
              tracklist: [
                { position: '1', title: 'VI Scose Poise', duration: '6:45' },
                { position: '2', title: 'Cfern', duration: '7:01' },
              ],
              full_release_date: '2001-04-30',
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const req = {
        query: { artistName: 'Autechre', releaseTitle: 'Confield' },
      } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBe(12345);
      expect(result.discogsUrl).toBe('https://www.discogs.com/release/12345');
      expect(result.releaseYear).toBe(2001);
      expect(result.artworkUrl).toBe('https://i.discogs.com/art.jpg');
      expect(result.genres).toEqual(['Electronic']);
      expect(result.styles).toEqual(['IDM', 'Abstract']);
      expect(result.label).toBe('Warp');
      expect(result.discogsArtistId).toBe(3840);
      expect(result.fullReleaseDate).toBe('2001-04-30');
      expect(result.tracklist).toEqual([
        { position: '1', title: 'VI Scose Poise', duration: '6:45' },
        { position: '2', title: 'Cfern', duration: '7:01' },
      ]);
      // Streaming URLs from LML search results
      expect(result.spotifyUrl).toBe('https://open.spotify.com/album/abc');
      expect(result.appleMusicUrl).toBe('https://music.apple.com/album/xyz');
      expect(result.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=Autechre+Confield');
      expect(result.bandcampUrl).toBe('https://bandcamp.com/search?q=Autechre+Confield');
      expect(result.soundcloudUrl).toBe('https://soundcloud.com/search?q=Autechre+Confield');
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('returns fallback search URLs for all five services when LML search fails (BS#1185)', async () => {
      // Pre-BS#1185, Spotify and Apple Music had no search-URL fallback,
      // so an LML failure left iOS with two greyed buttons. Post-BS#1185,
      // all five services have search-URL fallbacks via `SearchUrlProvider`.
      mockLookupMetadata.mockRejectedValue(new Error('LML down'));

      const req = { query: { artistName: 'Test Artist', releaseTitle: 'Test Album' } } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBeUndefined();
      // Search URLs are always constructed as fallback — now all five
      expect(result.spotifyUrl).toContain('open.spotify.com/search');
      expect(result.appleMusicUrl).toContain('music.apple.com/search');
      expect(result.youtubeMusicUrl).toContain('music.youtube.com');
      expect(result.bandcampUrl).toContain('bandcamp.com');
      expect(result.soundcloudUrl).toContain('soundcloud.com');
    });

    it('omits discogsReleaseId/discogsUrl on LML synth shape (release_id=0, release_url="")', async () => {
      // LML#401: the streaming-only synth shape carries iTunes Apple URL
      // and search-URL fallbacks but no real Discogs identifiers. BS must
      // NOT surface release_id=0 / discogs_url="" on the proxy response.
      // Streaming URLs from the synth still flow through unchanged.
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 0,
              title: 'Tragic Magic',
              artist: 'Julianna Barwick & Mary Lattimore',
              call_number: '',
              library_url: '',
            },
            artwork: {
              release_id: 0,
              release_url: '',
              artwork_url: null,
              album: null,
              artist: null,
              confidence: 0,
              release_year: null,
              artist_bio: null,
              wikipedia_url: null,
              spotify_url: 'https://open.spotify.com/search/Julianna%20Barwick%20Tragic',
              apple_music_url: 'https://music.apple.com/us/album/tragic-magic/1843854211',
              youtube_music_url: 'https://music.youtube.com/search?q=Julianna%20Tragic',
              bandcamp_url: 'https://bandcamp.com/search?q=Julianna%20Tragic',
              soundcloud_url: 'https://soundcloud.com/search?q=Julianna%20Tragic',
            },
          },
        ],
        search_type: 'artist_only',
        song_not_found: false,
        found_on_compilation: false,
      });

      const req = {
        query: {
          artistName: 'Julianna Barwick & Mary Lattimore',
          releaseTitle: 'Tragic Magic',
          trackTitle: 'The Four Sleeping Princesses',
        },
      } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBeUndefined();
      expect(result.discogsUrl).toBeUndefined();
      // Streaming URLs from synth flow through.
      expect(result.appleMusicUrl).toBe('https://music.apple.com/us/album/tragic-magic/1843854211');
      expect(result.spotifyUrl).toBe('https://open.spotify.com/search/Julianna%20Barwick%20Tragic');
    });

    it('uses per-service fallback shape (YouTube + Bandcamp include album; SoundCloud does not)', async () => {
      // Pins the BS#889 contract at the controller layer. Pre-BS#889 the
      // three URLs shared a single combined `${artistName} ${searchTerm}`
      // query, so all three contained the album when releaseTitle was set
      // and trackTitle wasn't. The new SearchUrlProvider-backed behavior
      // is asymmetric: SoundCloud falls back to artist-only without album
      // because album-only SoundCloud queries return unrelated DJ mixes
      // more often than the album. A future regression that re-introduces
      // the combined-query pattern in the controller would fail this test
      // even if the provider-level tests stay green.
      mockLookupMetadata.mockRejectedValue(new Error('LML down'));

      const req = { query: { artistName: 'Stereolab', releaseTitle: 'Dots and Loops' } } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=Stereolab%20Dots%20and%20Loops');
      expect(result.bandcampUrl).toBe('https://bandcamp.com/search?q=Stereolab%20Dots%20and%20Loops');
      expect(result.soundcloudUrl).toBe('https://soundcloud.com/search?q=Stereolab');
    });

    it('omits enriched fields when the lookup artwork has no extended metadata', async () => {
      // The artwork block carries release-detail fields when LML's
      // extended pipeline finds them (`release_year`, `genres`, `styles`,
      // `tracklist`, `discogs_artist_id`, `full_release_date`). When the
      // artwork lacks those fields (LML matched the release but the
      // extended pipeline returned no enrichment), the proxy response
      // surfaces the search-only metadata (Discogs IDs + streaming URLs)
      // and omits the missing enriched fields rather than fabricating
      // them. No follow-up `getRelease()` call happens — the coordinator
      // forces `extended: true` on the single lookup.
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'Moon Pix',
              artist: 'Cat Power',
              call_number: 'Rock CD CAT 1/1',
              library_url: '',
            },
            artwork: {
              release_id: 99999,
              release_url: 'https://www.discogs.com/release/99999',
              artwork_url: 'https://i.discogs.com/art.jpg',
              album: 'Moon Pix',
              artist: 'Cat Power',
              confidence: 0.9,
              spotify_url: 'https://open.spotify.com/album/moonpix',
              apple_music_url: null,
              youtube_music_url: null,
              bandcamp_url: null,
              soundcloud_url: null,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const req = {
        query: { artistName: 'Cat Power', releaseTitle: 'Moon Pix' },
      } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBe(99999);
      expect(result.artworkUrl).toBe('https://i.discogs.com/art.jpg');
      // Streaming URLs from search result still present.
      expect(result.spotifyUrl).toBe('https://open.spotify.com/album/moonpix');
      // Enriched fields are omitted when the artwork doesn't carry them.
      expect(result.genres).toBeUndefined();
      expect(result.tracklist).toBeUndefined();
      // getRelease is never called on the album path post-BS#885.
      expect(mockGetRelease).not.toHaveBeenCalled();
    });

    it('strips Discogs spacer.gif placeholder from artworkUrl (#649)', async () => {
      // The iOS playcut-detail endpoint returns artworkUrl directly to the
      // client. Discogs occasionally sends spacer.gif as a placeholder when a
      // release has no real cover art; passing that through results in a
      // broken/blank image on iOS. Drop it at this callsite the same way
      // metadata.service.ts does.
      // Post-BS#885: release-detail fields come back inline on the
      // artwork block (coordinator forces `extended: true`).
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'On Your Own Love Again',
              artist: 'Jessica Pratt',
              call_number: 'Rock CD PRA 1/1',
              library_url: '',
            },
            artwork: {
              release_id: 7777,
              release_url: 'https://www.discogs.com/release/7777',
              artwork_url: 'https://s.discogs.com/images/spacer.gif',
              album: 'On Your Own Love Again',
              artist: 'Jessica Pratt',
              confidence: 0.92,
              spotify_url: null,
              apple_music_url: null,
              youtube_music_url: null,
              bandcamp_url: null,
              soundcloud_url: null,
              release_year: 2015,
              label: 'Drag City',
              discogs_artist_id: 5555,
              genres: ['Rock'],
              styles: [],
              tracklist: [],
              full_release_date: '2015-02-03',
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const req = {
        query: { artistName: 'Jessica Pratt', releaseTitle: 'On Your Own Love Again' },
      } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      // artworkUrl is dropped entirely so iOS knows to draw its own placeholder.
      expect(result.artworkUrl).toBeUndefined();
      // Other Discogs metadata is preserved — spacer.gif is only a cover-art
      // placeholder, not an "the entire release is bogus" signal.
      expect(result.discogsReleaseId).toBe(7777);
      expect(result.label).toBe('Drag City');
    });

    it('returns fallback search URLs for all five services when LML search returns empty results (BS#1185)', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [],
        search_type: 'none',
        song_not_found: false,
        found_on_compilation: false,
      });

      const req = { query: { artistName: 'Obscure Artist', releaseTitle: 'Unknown Album' } } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBeUndefined();
      // Post-BS#1185: all five streaming services have search-URL fallbacks.
      expect(result.spotifyUrl).toContain('open.spotify.com/search');
      expect(result.appleMusicUrl).toContain('music.apple.com/search');
      expect(result.youtubeMusicUrl).toContain('music.youtube.com');
      expect(result.youtubeMusicUrl).toContain('Obscure%20Artist');
      expect(result.bandcampUrl).toContain('bandcamp.com');
      expect(result.soundcloudUrl).toContain('soundcloud.com');
      expect(mockGetRelease).not.toHaveBeenCalled();
    });

    // --- Single-call path (the only path post-BS#885) ---
    //
    // The coordinator forces `extended: true`, so LML returns the
    // release-detail fields inline on the lookup response's `artwork`
    // block. No follow-up `getRelease()` call. (The `PROXY_METADATA_SINGLE_LOOKUP`
    // env flag and its legacy two-call branch were removed when this
    // coordinator landed; BS#918 cleanup folded here.)

    describe('extended-mode response shape', () => {
      it('reads release-detail fields off the lookup artwork and skips getRelease', async () => {
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
                artwork_url: 'https://i.discogs.com/art.jpg',
                album: 'Confield',
                artist: 'Autechre',
                confidence: 0.95,
                release_year: 2001,
                spotify_url: 'https://open.spotify.com/album/abc',
                apple_music_url: 'https://music.apple.com/album/xyz',
                youtube_music_url: 'https://music.youtube.com/search?q=Autechre+Confield',
                bandcamp_url: 'https://bandcamp.com/search?q=Autechre+Confield',
                soundcloud_url: 'https://soundcloud.com/search?q=Autechre+Confield',
                // Extended-mode fields (new in @wxyc/shared 1.5.0)
                discogs_artist_id: 3840,
                tracklist: [
                  { position: '1', title: 'VI Scose Poise', duration: '6:45' },
                  { position: '2', title: 'Cfern', duration: '7:01' },
                ],
                genres: ['Electronic'],
                styles: ['IDM', 'Abstract'],
                label: 'Warp',
                full_release_date: '2001-04-30',
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Autechre', releaseTitle: 'Confield' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Same iOS-facing contract as the legacy path.
        expect(result.discogsReleaseId).toBe(12345);
        expect(result.discogsUrl).toBe('https://www.discogs.com/release/12345');
        expect(result.releaseYear).toBe(2001);
        expect(result.artworkUrl).toBe('https://i.discogs.com/art.jpg');
        expect(result.genres).toEqual(['Electronic']);
        expect(result.styles).toEqual(['IDM', 'Abstract']);
        expect(result.label).toBe('Warp');
        expect(result.discogsArtistId).toBe(3840);
        expect(result.fullReleaseDate).toBe('2001-04-30');
        expect(result.tracklist).toEqual([
          { position: '1', title: 'VI Scose Poise', duration: '6:45' },
          { position: '2', title: 'Cfern', duration: '7:01' },
        ]);
        // Streaming URLs preserved.
        expect(result.spotifyUrl).toBe('https://open.spotify.com/album/abc');
        expect(result.appleMusicUrl).toBe('https://music.apple.com/album/xyz');

        // The whole point of this PR: no follow-up LML call.
        expect(mockGetRelease).not.toHaveBeenCalled();

        // Post-BS#885: callsite no longer passes `extended` — the
        // LmlLookupCoordinator forces it on the wire. The coordinator
        // mock receives the callsite args; `extended` is applied inside
        // the (real) coordinator's fetchUncached path.
        // BS#1826 PR 2: `proxy-album-metadata` is class 2 — budget
        // (4000ms) and timeout (5000ms) come from the per-caller policy
        // layer now, not a call-site `budgetMs` literal.
        expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield', undefined, {
          caller: 'proxy-album-metadata',
        });
      });

      it('omits empty-string label/fullReleaseDate (parity with the local-hit branch, BS#1336)', async () => {
        // The cold branch uses `|| undefined` (not `?? undefined`) so an
        // empty-string label/date is omitted, not emitted as "". This keeps
        // it byte-identical to buildLocalMetadataResponse's `if (persisted.x)`
        // truthy guard for the empty-string case.
        mockLookupMetadata.mockResolvedValue({
          results: [
            {
              library_item: { id: 1, title: 'Album', artist: 'Artist', call_number: '', library_url: '' },
              artwork: {
                release_id: 7,
                release_url: 'https://www.discogs.com/release/7',
                artwork_url: 'https://i.discogs.com/a.jpg',
                album: 'Album',
                artist: 'Artist',
                confidence: 0.9,
                label: '',
                full_release_date: '',
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = { query: { artistName: 'Artist', releaseTitle: 'Album' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        // Parity is about the serialized wire output: `|| undefined` leaves the
        // value undefined, which JSON.stringify drops — matching the local
        // branch's omitted key. Assert via round-tripped JSON, not the
        // in-memory object (which carries the key with an undefined value).
        const wire = JSON.parse(JSON.stringify((res.json as jest.Mock).mock.calls[0][0]));
        expect('label' in wire).toBe(false);
        expect('fullReleaseDate' in wire).toBe(false);
      });

      it('falls back to search URLs when LML lookup returns empty results', async () => {
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Obscure Artist', releaseTitle: 'Unknown Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.discogsReleaseId).toBeUndefined();
        // Search URLs still constructed as fallback.
        expect(result.youtubeMusicUrl).toContain('music.youtube.com');
        expect(result.bandcampUrl).toContain('bandcamp.com');
        expect(result.soundcloudUrl).toContain('soundcloud.com');
        // No follow-up call even in the no-match case.
        expect(mockGetRelease).not.toHaveBeenCalled();
      });

      it('falls back to search URLs when LML lookup throws', async () => {
        mockLookupMetadata.mockRejectedValue(new Error('LML down'));

        const req = {
          query: { artistName: 'Test Artist', releaseTitle: 'Test Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.discogsReleaseId).toBeUndefined();
        // Search URLs still constructed.
        expect(result.youtubeMusicUrl).toContain('music.youtube.com');
        expect(mockGetRelease).not.toHaveBeenCalled();
      });

      it('strips spacer.gif from artworkUrl on the single-call path (#649)', async () => {
        mockLookupMetadata.mockResolvedValue({
          results: [
            {
              library_item: {
                id: 1,
                title: 'On Your Own Love Again',
                artist: 'Jessica Pratt',
                call_number: 'Rock CD PRA 1/1',
                library_url: '',
              },
              artwork: {
                release_id: 7777,
                release_url: 'https://www.discogs.com/release/7777',
                artwork_url: 'https://s.discogs.com/images/spacer.gif',
                album: 'On Your Own Love Again',
                artist: 'Jessica Pratt',
                confidence: 0.92,
                release_year: 2015,
                discogs_artist_id: 5555,
                tracklist: [],
                genres: ['Rock'],
                styles: [],
                label: 'Drag City',
                full_release_date: '2015-02-03',
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Jessica Pratt', releaseTitle: 'On Your Own Love Again' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        // spacer.gif dropped so iOS draws its own placeholder.
        expect(result.artworkUrl).toBeUndefined();
        // Other release fields still preserved.
        expect(result.discogsReleaseId).toBe(7777);
        expect(result.label).toBe('Drag City');
      });

      it('coerces Discogs release_year=0 sentinel to undefined (#1002)', async () => {
        // Discogs returns 0 when a release has no verified year. The iOS
        // playcut detail view renders this as "Release year: 0" if the
        // proxy passes it through. Mirrors the chokepoint in
        // `metadata.service.ts#extractAlbumMetadata`.
        mockLookupMetadata.mockResolvedValue({
          results: [
            {
              library_item: {
                id: 1,
                title: 'DOGA',
                artist: 'Juana Molina',
                call_number: 'Rock CD MOL 1/1',
                library_url: '',
              },
              artwork: {
                release_id: 8888,
                release_url: 'https://www.discogs.com/release/8888',
                artwork_url: 'https://i.discogs.com/art.jpg',
                album: 'DOGA',
                artist: 'Juana Molina',
                confidence: 0.93,
                release_year: 0,
                discogs_artist_id: 4444,
                tracklist: [],
                genres: ['Rock'],
                styles: [],
                label: 'Sonamos',
                full_release_date: null,
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Juana Molina', releaseTitle: 'DOGA' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.releaseYear).toBeUndefined();
        // Other release fields still preserved.
        expect(result.discogsReleaseId).toBe(8888);
        expect(result.label).toBe('Sonamos');
      });
    });

    // --- Cache-first local-lookup path (BS#1331) ---
    //
    // The handler now consults persisted state (album_metadata joined to
    // flowsheet by the normalized `lower(trim(artist))-lower(trim(album))`
    // lookup key, partial-indexed by `flowsheet_album_link_lookup_idx`)
    // before going to LML. On a local hit it serves what BS already knows
    // — no LML round-trip, no Discogs rate-limiter wait, no request-time
    // search-URL synthesis (which would launder LML's verified-rejection
    // signal; BS#1192). Sentry `proxy.metadata.album.upstream_calls` reads
    // 0 on local hit so the cohort split survives in the trace explorer.
    describe('cache-first local lookup (BS#1331)', () => {
      it('serves persisted state without invoking LML when local row is enriched', async () => {
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: 'https://i.discogs.com/cached.jpg',
          discogs_url: 'https://www.discogs.com/release/54321',
          release_year: 2024,
          spotify_url: 'https://open.spotify.com/album/cachedspot',
          apple_music_url: 'https://music.apple.com/album/cachedapple',
          youtube_music_url: 'https://music.youtube.com/playlist?list=cachedyt',
          bandcamp_url: 'https://artist.bandcamp.com/album/cached',
          soundcloud_url: 'https://soundcloud.com/artist/cached-album',
          artist_bio: 'A cached bio of the artist.',
          artist_wikipedia_url: 'https://en.wikipedia.org/wiki/CachedArtist',
        });

        const req = {
          query: { artistName: 'Cached Artist', releaseTitle: 'Cached Album', trackTitle: 'Cached Track' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledWith('Cached Artist', 'Cached Album');
        expect(mockLookupAlbumMetadataById).toHaveBeenCalledWith(DEFAULT_LINKED_ALBUM_ID);
        expect(mockLookupMetadata).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.artworkUrl).toBe('https://i.discogs.com/cached.jpg');
        expect(result.discogsUrl).toBe('https://www.discogs.com/release/54321');
        // Derived from discogs_url so iOS V1 callers keep getting the
        // release id field they previously read off LML's artwork block.
        expect(result.discogsReleaseId).toBe(54321);
        expect(result.releaseYear).toBe(2024);
        expect(result.spotifyUrl).toBe('https://open.spotify.com/album/cachedspot');
        expect(result.appleMusicUrl).toBe('https://music.apple.com/album/cachedapple');
        expect(result.youtubeMusicUrl).toBe('https://music.youtube.com/playlist?list=cachedyt');
        expect(result.bandcampUrl).toBe('https://artist.bandcamp.com/album/cached');
        expect(result.soundcloudUrl).toBe('https://soundcloud.com/artist/cached-album');
        expect(result.artistBio).toBe('A cached bio of the artist.');
        expect(result.artistWikipediaUrl).toBe('https://en.wikipedia.org/wiki/CachedArtist');
        expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
      });

      it('suppresses a persisted mislabeled spotify_url/apple_music_url, synthesizing the search fallback (BS#1714)', async () => {
        // Pre-#1712 fill-only persistence left non-Spotify/non-Apple URLs under
        // these two columns (e.g. a Deezer URL under spotify_url on release
        // id=1580). The host guard must not serve them under the hardwired iOS
        // "Spotify"/"Apple Music" button; not setting them lets the request-time
        // fallback synthesize a real open.spotify.com/search URL instead.
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: 'https://i.discogs.com/cached.jpg',
          discogs_url: 'https://www.discogs.com/release/1580',
          release_year: 2024,
          spotify_url: 'https://www.deezer.com/album/254381182',
          apple_music_url: 'https://tidal.com/browse/album/254381182',
          youtube_music_url: 'https://music.youtube.com/playlist?list=cachedyt',
          bandcamp_url: 'https://artist.bandcamp.com/album/cached',
          soundcloud_url: 'https://soundcloud.com/artist/cached-album',
          artist_bio: 'A cached bio of the artist.',
          artist_wikipedia_url: 'https://en.wikipedia.org/wiki/CachedArtist',
        });

        const req = {
          query: { artistName: 'Cached Artist', releaseTitle: 'Cached Album', trackTitle: 'Cached Track' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupMetadata).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Mislabeled → dropped, then synthesized (never the Deezer/Tidal URL).
        expect(result.spotifyUrl).not.toBe('https://www.deezer.com/album/254381182');
        expect(result.spotifyUrl).toContain('open.spotify.com/search');
        expect(result.appleMusicUrl).not.toBe('https://tidal.com/browse/album/254381182');
        expect(result.appleMusicUrl).toContain('music.apple.com/search');
        // The other three streaming slots are untouched by the guard.
        expect(result.youtubeMusicUrl).toBe('https://music.youtube.com/playlist?list=cachedyt');
        expect(result.bandcampUrl).toBe('https://artist.bandcamp.com/album/cached');
        expect(result.soundcloudUrl).toBe('https://soundcloud.com/artist/cached-album');
      });

      it('emits the 8 LML-only fields on a local hit, matching the cold extended-mode shape (BS#1336)', async () => {
        // Pre-1336, a cache hit shed genres/styles/label/fullReleaseDate/
        // tracklist/artistImageUrl/bioTokens/discogsArtistId — the cold
        // LML-fallthrough returned them, a hit omitted them. Now the worker
        // persists them and this branch emits them with the same conventions
        // as `populateReleaseMetadata` + `populateCommonMetadataFields`.
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: 'https://i.discogs.com/art.jpg',
          discogs_url: 'https://www.discogs.com/release/12345',
          release_year: 2001,
          spotify_url: 'https://open.spotify.com/album/abc',
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
          discogs_artist_id: 3840,
          label: 'Warp',
          full_release_date: '2001-04-30',
          genres: ['Electronic'],
          styles: ['IDM', 'Abstract'],
          tracklist: [
            { position: '1', title: 'VI Scose Poise', duration: '6:45' },
            { position: '2', title: 'Cfern', duration: '7:01' },
          ],
          artist_image_url: 'https://i.discogs.com/artist.jpg',
          bio_tokens: [{ type: 'plainText', text: 'Sheffield electronic duo' }],
        });

        const req = {
          query: { artistName: 'Autechre', releaseTitle: 'Confield' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupMetadata).not.toHaveBeenCalled();
        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Property-for-property with the extended-mode (cold) test above.
        expect(result.discogsArtistId).toBe(3840);
        expect(result.genres).toEqual(['Electronic']);
        expect(result.styles).toEqual(['IDM', 'Abstract']);
        expect(result.label).toBe('Warp');
        expect(result.fullReleaseDate).toBe('2001-04-30');
        expect(result.tracklist).toEqual([
          { position: '1', title: 'VI Scose Poise', duration: '6:45' },
          { position: '2', title: 'Cfern', duration: '7:01' },
        ]);
        expect(result.artistImageUrl).toBe('https://i.discogs.com/artist.jpg');
        expect(result.bioTokens).toEqual([{ type: 'plainText', text: 'Sheffield electronic duo' }]);
      });

      it('discogsArtistId parity: present-as-null on a match-shaped row, omitted on a no-match-shaped row (BS#1336)', async () => {
        // The cold LML *match* branch always emits `discogsArtistId` (`?? null`);
        // its *no-match* branch emits neither artwork nor discogsArtistId. The
        // local branch mirrors both: gated on `discogs_url` (the match-shape
        // marker), so a match row with a null artist id still carries the key.
        mockLookupAlbumMetadataById.mockResolvedValueOnce({
          artwork_url: 'https://i.discogs.com/art.jpg',
          discogs_url: 'https://www.discogs.com/release/55',
          release_year: 2019,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
          discogs_artist_id: null,
          label: null,
          full_release_date: null,
          genres: null,
          styles: null,
          tracklist: null,
          artist_image_url: null,
          bio_tokens: null,
        });

        const reqMatch = { query: { artistName: 'Match', releaseTitle: 'Shaped' } } as unknown as Request;
        const resMatch = createMockRes();
        await getAlbumMetadata(reqMatch, resMatch as Response, mockNext);
        const matchResult = (resMatch.json as jest.Mock).mock.calls[0][0];
        // Key present, value literal null — matches the cold match branch.
        expect('discogsArtistId' in matchResult).toBe(true);
        expect(matchResult.discogsArtistId).toBeNull();

        // No-match-shaped row: discogs_url null (the no-match UPSERT writes only
        // search URLs), so discogsArtistId is omitted like the cold no-match.
        mockLookupAlbumMetadataById.mockResolvedValueOnce({
          artwork_url: null,
          discogs_url: null,
          release_year: null,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: 'https://music.youtube.com/search?q=x',
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
          discogs_artist_id: null,
          label: null,
          full_release_date: null,
          genres: null,
          styles: null,
          tracklist: null,
          artist_image_url: null,
          bio_tokens: null,
        });

        const reqNoMatch = { query: { artistName: 'NoMatch', releaseTitle: 'Shaped' } } as unknown as Request;
        const resNoMatch = createMockRes();
        await getAlbumMetadata(reqNoMatch, resNoMatch as Response, mockNext);
        const noMatchResult = (resNoMatch.json as jest.Mock).mock.calls[0][0];
        expect('discogsArtistId' in noMatchResult).toBe(false);
      });

      it('catch-arm-shape row: persisted YT/BC/SC win, missing Apple/Spotify synthesized at request time (no LML)', async () => {
        // BS#873 catch arm at enrichment.service.ts writes only the three
        // synth-able streaming URLs on LML failure (no Apple, no Spotify,
        // no artwork, no Discogs). The persisted URLs win — request-time
        // synthesis only fills the keys the persisted row left null. The
        // BS#1192 "verified rejection" invariant is a write-path concern
        // (don't persist synth URLs in album_metadata); synthesizing at
        // request time doesn't poison persisted state, and matching the
        // LML-fallthrough branch's behavior means iOS sees the same
        // degraded-but-usable shape regardless of cohort.
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: null,
          discogs_url: null,
          release_year: null,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: 'https://music.youtube.com/search?q=Bill%20Orcutt%20Music%20For%20Four%20Guitars',
          bandcamp_url: 'https://bandcamp.com/search?q=Bill%20Orcutt%20Music%20For%20Four%20Guitars',
          soundcloud_url: 'https://soundcloud.com/search?q=Bill%20Orcutt',
          artist_bio: null,
          artist_wikipedia_url: null,
        });

        const req = {
          query: { artistName: 'Bill Orcutt', releaseTitle: 'Music For Four Guitars' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupMetadata).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Persisted catch-arm URLs win over synthesis.
        expect(result.youtubeMusicUrl).toBe(
          'https://music.youtube.com/search?q=Bill%20Orcutt%20Music%20For%20Four%20Guitars'
        );
        expect(result.bandcampUrl).toBe('https://bandcamp.com/search?q=Bill%20Orcutt%20Music%20For%20Four%20Guitars');
        expect(result.soundcloudUrl).toBe('https://soundcloud.com/search?q=Bill%20Orcutt');
        // Missing Apple/Spotify get synthesized — same fallback the
        // LML-fallthrough branch has used since BS#1185.
        expect(result.appleMusicUrl).toContain('music.apple.com/search');
        expect(result.spotifyUrl).toContain('open.spotify.com/search');
        // Persisted nulls on the non-URL fields stay absent.
        expect(result.artworkUrl).toBeUndefined();
        expect(result.discogsUrl).toBeUndefined();
        expect(result.discogsReleaseId).toBeUndefined();
      });

      it('all-null persisted row: every streaming URL gets a synthesized search-URL fallback (no LML)', async () => {
        // The success-no-match write path at enrichment.service.ts:114-148
        // persists `metadata.album?.X ?? null` for every column, so an
        // LML success with no Discogs/Spotify/iTunes match produces a row
        // with all 10 columns null. Without request-time synthesis the
        // handler would return `{}` to iOS — every streaming button greys
        // out. Synthesizing here matches the cold-path behavior.
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: null,
          discogs_url: null,
          release_year: null,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
        });

        const req = {
          query: { artistName: 'No Match Artist', releaseTitle: 'No Match Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupMetadata).not.toHaveBeenCalled();
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.spotifyUrl).toContain('open.spotify.com/search');
        expect(result.appleMusicUrl).toContain('music.apple.com/search');
        expect(result.youtubeMusicUrl).toContain('music.youtube.com');
        expect(result.bandcampUrl).toContain('bandcamp.com');
        expect(result.soundcloudUrl).toContain('soundcloud.com');
      });

      it('strips Discogs spacer.gif from persisted artwork_url on local hit (#649)', async () => {
        // album_metadata.artwork_url can carry spacer.gif from the
        // historical album-metadata-backfill (verbatim INSERT…SELECT) or
        // pre-#649 flowsheet rows. The local-hit path must scrub via
        // filterSpacerGif so iOS's "missing → placeholder" fallback
        // doesn't render the 1×1 tracking pixel as cover art.
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: 'https://s.discogs.com/images/spacer.gif',
          discogs_url: 'https://www.discogs.com/release/777',
          release_year: 2015,
          spotify_url: 'https://open.spotify.com/album/spacer',
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
        });

        const req = {
          query: { artistName: 'Spacer Artist', releaseTitle: 'Spacer Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.artworkUrl).toBeUndefined();
        // Other persisted fields still surface.
        expect(result.discogsUrl).toBe('https://www.discogs.com/release/777');
        expect(result.discogsReleaseId).toBe(777);
      });

      it('falls through to LML when the local lookup throws (DB blip should not 500 the request)', async () => {
        // Without this guard a transient pool-exhaust / statement_timeout
        // / RDS failover would propagate to the global error handler and
        // return 500, regressing availability versus the pre-PR endpoint
        // (which had zero DB-failure surface). The graceful degradation
        // matches the LML-fallthrough path's own try/catch.
        mockLookupAlbumMetadataById.mockRejectedValue(new Error('asyncpg: connection refused'));
        mockLookupMetadata.mockResolvedValue({
          results: [
            {
              library_item: { id: 1, title: 'Album', artist: 'Artist', call_number: '', library_url: '' },
              artwork: {
                release_id: 11,
                release_url: 'https://www.discogs.com/release/11',
                artwork_url: 'https://i.discogs.com/a.jpg',
                album: 'Album',
                artist: 'Artist',
                confidence: 0.9,
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = { query: { artistName: 'Artist', releaseTitle: 'Album' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({ 'proxy.metadata.album.upstream_calls': 1 });
        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.discogsReleaseId).toBe(11);
      });

      it('falls through to LML when no local row matches (true cold case)', async () => {
        // No linked album resolves at all — the by-id metadata read never runs.
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [
            {
              library_item: { id: 1, title: 'Cold Album', artist: 'Cold Artist', call_number: '', library_url: '' },
              artwork: {
                release_id: 99,
                release_url: 'https://www.discogs.com/release/99',
                artwork_url: 'https://i.discogs.com/cold.jpg',
                album: 'Cold Album',
                artist: 'Cold Artist',
                confidence: 0.9,
                spotify_url: 'https://open.spotify.com/album/cold',
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Cold Artist', releaseTitle: 'Cold Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledWith('Cold Artist', 'Cold Album');
        expect(mockLookupAlbumMetadataById).not.toHaveBeenCalled();
        // LML was consulted because the resolve step found no linked album.
        expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.discogsReleaseId).toBe(99);
        expect(result.artworkUrl).toBe('https://i.discogs.com/cold.jpg');
      });

      it('projects upstream_calls=0 onto the active Sentry span on local hit', async () => {
        // The hook here is the trace-explorer cohort split: anything > 0
        // is a fallthrough, 0 is a steady-state hit. Without this signal
        // we can't distinguish "the cache-first path saved 5s" from "we
        // never reached the cache-first path" in the prod p95.
        mockLookupAlbumMetadataById.mockResolvedValue({
          artwork_url: 'https://i.discogs.com/x.jpg',
          discogs_url: 'https://www.discogs.com/release/1',
          release_year: 2020,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
        });

        const req = {
          query: { artistName: 'Local Artist', releaseTitle: 'Local Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockSpanSetAttributes).toHaveBeenCalledWith({ 'proxy.metadata.album.upstream_calls': 0 });
      });
    });

    // --- Local-first base fields (BS#1827) ---
    //
    // Base playcut metadata (artist/release/track identity, plus
    // record_label/label_id/metadata_status when a linked flowsheet row is
    // known) is assembled from durable BS state BEFORE any LML lookup is
    // attempted, so an LML failure/timeout can only drop OPTIONAL enrichment
    // fields (artworkUrl, discogsUrl, genres, ...) — it can never blank the
    // base fields. This is the acceptance gate for #1827: simulate an LML
    // failure and assert base fields survive while enrichment fields don't.
    //
    // Round 2 (post-review): album_id and the base catalog fields now come
    // from ONE `selectLinkedFlowsheetRow` call instead of two separate reads
    // (`resolveLinkedAlbumId` then `resolveLinkedFlowsheetBase`), eliminating
    // a re-resolution race where a concurrent flowsheet insert between the
    // two calls could make them describe different rows. Tests that care
    // assert `toHaveBeenCalledTimes(1)` to pin the single-round-trip contract.
    describe('local-first base fields (BS#1827)', () => {
      it('always echoes artistName/releaseTitle/trackTitle from the query, before any lookup is attempted', async () => {
        // No mocks configured to resolve anything — the point is these three
        // never depend on a successful local or LML lookup in the first place.
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Chuquimamani-Condori', releaseTitle: 'Edits', trackTitle: 'Call Your Name' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.artistName).toBe('Chuquimamani-Condori');
        expect(result.releaseTitle).toBe('Edits');
        expect(result.trackTitle).toBe('Call Your Name');
      });

      it('omits releaseTitle/trackTitle when not supplied on the request (no fabrication)', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockRejectedValue(new Error('LML down'));

        const req = { query: { artistName: 'Solo Artist Name Only' } } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect(result.artistName).toBe('Solo Artist Name Only');
        expect('releaseTitle' in result).toBe(false);
        expect('trackTitle' in result).toBe(false);
      });

      it('free-text row (no linked album_id) + LML failure: artist/release/track survive; recordLabel/labelId/metadataStatus are not fabricated', async () => {
        // The core free-text scenario the issue names: selectLinkedFlowsheetRow
        // returns null (no album_id-bearing flowsheet row for this key) — there
        // is no efficient local source for record_label/label_id in that
        // cohort (see selectLinkedFlowsheetRow's doc comment). The identity
        // fields still must not blank out just because LML also fails.
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockRejectedValue(new Error('LML timeout'));

        const req = {
          query: { artistName: 'Free Text Artist', releaseTitle: 'Free Text Album', trackTitle: 'Some Track' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledTimes(1);
        expect(mockLookupAlbumMetadataById).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Base identity: survives.
        expect(result.artistName).toBe('Free Text Artist');
        expect(result.releaseTitle).toBe('Free Text Album');
        expect(result.trackTitle).toBe('Some Track');
        // No locally-known label/status for this cohort — omitted, not null.
        expect('recordLabel' in result).toBe(false);
        expect('labelId' in result).toBe(false);
        expect('metadataStatus' in result).toBe(false);
        // Enriched-only fields are genuinely absent (LML failed).
        expect('discogsUrl' in result).toBe(false);
        expect('artworkUrl' in result).toBe(false);
      });

      it('linked row known locally + LML failure: recordLabel/labelId/metadataStatus ALSO survive, only enrichment fields go missing', async () => {
        // The other half of the acceptance criterion: a linked flowsheet row
        // (album_id resolved) that hasn't been enriched into album_metadata
        // yet (persisted stays null, same as the existing "cold" default) —
        // an LML outage must not blank the record_label/label_id/
        // metadata_status this endpoint can read straight off that row. One
        // call resolves both album_id and the base fields (`toHaveBeenCalledTimes(1)`
        // pins that there's no second, separately-racing query anymore).
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: 'Drag City',
          label_id: 12,
          metadata_status: 'pending',
        });
        mockLookupAlbumMetadataById.mockResolvedValue(null);
        mockLookupMetadata.mockRejectedValue(new Error('LML down'));

        const req = {
          query: { artistName: 'Jessica Pratt', releaseTitle: 'On Your Own Love Again', trackTitle: 'Back, Baby' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledWith('Jessica Pratt', 'On Your Own Love Again');
        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledTimes(1);
        expect(mockLookupAlbumMetadataById).toHaveBeenCalledWith(DEFAULT_LINKED_ALBUM_ID);
        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Base identity.
        expect(result.artistName).toBe('Jessica Pratt');
        expect(result.releaseTitle).toBe('On Your Own Love Again');
        expect(result.trackTitle).toBe('Back, Baby');
        // Base catalog fields sourced locally — survive the LML failure.
        expect(result.recordLabel).toBe('Drag City');
        expect(result.labelId).toBe(12);
        expect(result.metadataStatus).toBe('pending');
        // Enrichment-only fields are genuinely absent (nothing persisted, LML failed).
        expect('discogsUrl' in result).toBe(false);
        expect('artworkUrl' in result).toBe(false);
        expect('genres' in result).toBe(false);
      });

      it('omits labelId/recordLabel individually when the linked row only knows one of them', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: null,
          label_id: 9,
          metadata_status: 'enriching',
        });
        mockLookupMetadata.mockRejectedValue(new Error('LML down'));

        const req = {
          query: { artistName: 'Partial Base Artist', releaseTitle: 'Partial Base Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        const result = (res.json as jest.Mock).mock.calls[0][0];
        expect('recordLabel' in result).toBe(false);
        expect(result.labelId).toBe(9);
        expect(result.metadataStatus).toBe('enriching');
      });

      it('selectLinkedFlowsheetRow throws: falls through to LML, omitting both base and persisted-state fields, still responds 200', async () => {
        // Mirrors the local-metadata try/catch convention elsewhere in this
        // handler: a DB blip resolving the row degrades to a cache miss and
        // falls through to LML, rather than 500ing the request. Because
        // album_id and the base fields now come from the SAME query (round-2
        // refactor), a failure here can no longer "partially" fail — the
        // persisted-metadata read is never reached either, unlike the old
        // two-query version where a base-fields-only failure could leave an
        // already-resolved album_id/persisted response intact.
        mockSelectLinkedFlowsheetRow.mockRejectedValue(new Error('db blip'));
        mockLookupMetadata.mockRejectedValue(new Error('LML down'));

        const req = {
          query: { artistName: 'Resilient Artist', releaseTitle: 'Resilient Album' },
        } as unknown as Request;
        const res = createMockRes();

        await getAlbumMetadata(req, res as Response, mockNext);

        expect(mockLookupAlbumMetadataById).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        const result = (res.json as jest.Mock).mock.calls[0][0];
        // Base identity survives — it never depended on this lookup.
        expect(result.artistName).toBe('Resilient Artist');
        expect(result.releaseTitle).toBe('Resilient Album');
        // Base catalog fields and enrichment fields are both genuinely absent.
        expect('recordLabel' in result).toBe(false);
        expect('labelId' in result).toBe(false);
        expect('metadataStatus' in result).toBe(false);
        expect('discogsUrl' in result).toBe(false);
      });
    });

    // --- Server-side response cache (BS#988) ---
    //
    // The cache-first local-lookup suite above proves BS's own persisted
    // state short-circuits LML. This suite proves the NEW layer in front of
    // BOTH the persisted-state read and the LML round-trip: an identical
    // repeat request is served from an in-process cache without touching
    // either, and — mirroring the #1089 negative-cache rule for
    // `searchArtwork` — a transient failure (a local DB blip or an LML
    // timeout/5xx/network error) is never memoized, so a repeat request
    // after a transient failure keeps retrying.
    describe('server-side response cache (BS#988)', () => {
      it('serves an identical repeat request from cache without a second LML round-trip', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [
            {
              library_item: { id: 1, title: 'Ege Bamyasi', artist: 'Can', call_number: '', library_url: '' },
              artwork: {
                release_id: 555,
                release_url: 'https://www.discogs.com/release/555',
                artwork_url: 'https://i.discogs.com/can.jpg',
                album: 'Ege Bamyasi',
                artist: 'Can',
                confidence: 0.9,
              },
            },
          ],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = { query: { artistName: 'Can', releaseTitle: 'Ege Bamyasi' } } as unknown as Request;

        const firstRes = createMockRes();
        await getAlbumMetadata(req, firstRes as Response, mockNext);
        expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
        const firstResult = (firstRes.json as jest.Mock).mock.calls[0][0];
        expect(firstResult.discogsReleaseId).toBe(555);

        const secondRes = createMockRes();
        await getAlbumMetadata(req, secondRes as Response, mockNext);

        // Neither the local lookup nor LML is re-consulted.
        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledTimes(1);
        expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
        const secondResult = (secondRes.json as jest.Mock).mock.calls[0][0];
        expect(secondResult.discogsReleaseId).toBe(555);
        // Base identity fields are still assembled fresh from THIS request.
        expect(secondResult.artistName).toBe('Can');
      });

      it('projects cache_hit=true onto the Sentry span on a repeat request, cache_hit=false on the first', async () => {
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Cache Hit Artist', releaseTitle: 'Cache Hit Album' },
        } as unknown as Request;

        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        // BS#989: chokepoint cache-stats projection (replaces the old
        // `proxy.metadata.album.cache_hit`-only attribute). cache_size=1
        // because the miss path populates the cache before this call.
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: false,
          cache_name: 'metadata_album',
          cache_size: 1,
          cache_capacity: 2000,
        });

        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: true,
          cache_name: 'metadata_album',
          cache_size: 1,
          cache_capacity: 2000,
        });
        // A cache hit makes zero upstream calls, same as a local hit.
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({ 'proxy.metadata.album.upstream_calls': 0 });
      });

      it('does not cache a transient LML failure: a repeat request re-attempts the lookup', async () => {
        // Mirrors the #1089 artwork negative-cache test: an LML timeout/5xx/
        // network blip must never strand a degraded response in the cache
        // for the full TTL.
        mockSelectLinkedFlowsheetRow.mockResolvedValue(null);
        mockLookupMetadata.mockRejectedValue(new Error('LML timeout'));

        const req = {
          query: { artistName: 'Flaky LML Artist', releaseTitle: 'Flaky LML Album' },
        } as unknown as Request;

        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);

        expect(mockLookupMetadata).toHaveBeenCalledTimes(2);
      });

      it('does not cache a local-lookup DB failure: a repeat request re-attempts the local read', async () => {
        mockSelectLinkedFlowsheetRow.mockRejectedValue(new Error('db blip'));
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });

        const req = {
          query: { artistName: 'Flaky DB Artist', releaseTitle: 'Flaky DB Album' },
        } as unknown as Request;

        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);

        expect(mockSelectLinkedFlowsheetRow).toHaveBeenCalledTimes(2);
      });

      it('does not cache when the critic-reviews read throws: a repeat request re-attempts the whole lookup', async () => {
        // The critic-reviews sub-read is optional per-response (a throw
        // degrades to omitting the field, same as before), but it must
        // still prevent the whole album response from being memoized —
        // otherwise a transient reviews-DB blip strands a reviews-less
        // shape in the cache for the full TTL, same failure mode the
        // sibling local-DB/LML tests above guard against.
        mockCriticReviewsConfig.mockReturnValue({ enabled: true });
        // Terminal status so caching is gated ONLY by the reviews-throw guard
        // under test, not by BS#1893's non-terminal (pending) rule.
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: null,
          label_id: null,
          metadata_status: 'enriched_no_match',
        });
        mockLookupAlbumMetadataById.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });
        mockLookupCriticReviewsByAlbumId.mockRejectedValue(new Error('reviews db blip'));

        const req = {
          query: { artistName: 'Flaky Reviews Artist', releaseTitle: 'Flaky Reviews Album' },
        } as unknown as Request;

        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        await getAlbumMetadata(req, createMockRes() as Response, mockNext);

        // Both requests independently re-attempt the full lookup — nothing
        // was cached from the first (failed-reviews) attempt.
        expect(mockLookupCriticReviewsByAlbumId).toHaveBeenCalledTimes(2);
        expect(mockLookupMetadata).toHaveBeenCalledTimes(2);
      });

      it('still caches when the critic-reviews read succeeds', async () => {
        mockCriticReviewsConfig.mockReturnValue({ enabled: true });
        // Terminal status so the response is cacheable — this test asserts a
        // successful reviews read does NOT block caching (BS#1893's pending rule
        // would otherwise mask that behavior).
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: null,
          label_id: null,
          metadata_status: 'enriched_no_match',
        });
        mockLookupAlbumMetadataById.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });
        mockLookupCriticReviewsByAlbumId.mockResolvedValue([
          { source: 'The Quietus', url: 'https://thequietus.com/y', snippet: 'snippet' },
        ]);

        const req = {
          query: { artistName: 'Healthy Reviews Artist', releaseTitle: 'Healthy Reviews Album' },
        } as unknown as Request;

        await getAlbumMetadata(req, createMockRes() as Response, mockNext);
        const secondRes = createMockRes();
        await getAlbumMetadata(req, secondRes as Response, mockNext);

        // The second request is served entirely from cache.
        expect(mockLookupCriticReviewsByAlbumId).toHaveBeenCalledTimes(1);
        expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
        expect((secondRes.json as jest.Mock).mock.calls[0][0].criticReviews).toEqual([
          { source: 'The Quietus', url: 'https://thequietus.com/y', snippet: 'snippet' },
        ]);
      });

      it('keys the cache on the CRITIC_REVIEWS_ENABLED flag state so a flag flip is not served a stale shape', async () => {
        // Terminal status so both flag states cache — the two LML calls below
        // then prove the flag is part of the KEY (each flag state is a distinct
        // cold entry), not merely that BS#1893 skipped caching a pending row.
        mockSelectLinkedFlowsheetRow.mockResolvedValue({
          album_id: DEFAULT_LINKED_ALBUM_ID,
          record_label: null,
          label_id: null,
          metadata_status: 'enriched_no_match',
        });
        mockLookupAlbumMetadataById.mockResolvedValue(null);
        mockLookupMetadata.mockResolvedValue({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        });
        mockLookupCriticReviewsByAlbumId.mockResolvedValue([
          { source: 'The Quietus', url: 'https://thequietus.com/x', snippet: 'snippet' },
        ]);

        const req = {
          query: { artistName: 'Flag Split Artist', releaseTitle: 'Flag Split Album' },
        } as unknown as Request;

        // Flag off: cached without criticReviews.
        mockCriticReviewsConfig.mockReturnValue({ enabled: false });
        const offRes = createMockRes();
        await getAlbumMetadata(req, offRes as Response, mockNext);
        expect((offRes.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('criticReviews');

        // Flag on: a DIFFERENT cache key, so the response is computed fresh
        // (not served from the flag-off entry) and carries criticReviews.
        mockCriticReviewsConfig.mockReturnValue({ enabled: true });
        const onRes = createMockRes();
        await getAlbumMetadata(req, onRes as Response, mockNext);
        expect((onRes.json as jest.Mock).mock.calls[0][0].criticReviews).toEqual([
          { source: 'The Quietus', url: 'https://thequietus.com/x', snippet: 'snippet' },
        ]);

        expect(mockLookupMetadata).toHaveBeenCalledTimes(2);
      });
    });
  });

  // --- getArtistMetadata ---

  describe('getArtistMetadata', () => {
    beforeEach(() => {
      // BS#988: reset the response cache between tests — several tests below
      // reuse the same artistId (e.g. `3840`) for both a success case and a
      // rejection case, which would otherwise short-circuit on a cached hit
      // from an earlier test.
      __resetArtistMetadataCacheForTests();
    });

    it('throws WxycError 400 when artistId is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await expect(getArtistMetadata(req, res as Response, mockNext)).rejects.toThrow(
        'artistId query parameter is required'
      );
    });

    it('throws WxycError 400 when artistId is not a number', async () => {
      const req = { query: { artistId: 'abc' } } as unknown as Request;
      const res = createMockRes();

      await expect(getArtistMetadata(req, res as Response, mockNext)).rejects.toThrow('artistId must be an integer');
    });

    it('returns artist metadata with raw bio, bioTokens, imageUrl, and cache header', async () => {
      const profileTokens = [
        { type: 'plainText', text: 'Autechre is a British electronic music duo consisting of ' },
        {
          type: 'artistLink',
          name: 'Rob Brown',
          display_name: 'Rob Brown',
          url: 'https://www.discogs.com/search/?q=Rob%20Brown&type=artist',
        },
        { type: 'plainText', text: ' and ' },
        {
          type: 'artistLink',
          name: 'Sean Booth',
          display_name: 'Sean Booth',
          url: 'https://www.discogs.com/search/?q=Sean%20Booth&type=artist',
        },
        { type: 'plainText', text: '.' },
      ];

      mockGetArtistDetails.mockResolvedValue({
        artist_id: 3840,
        name: 'Autechre',
        profile: 'Autechre is a British electronic music duo consisting of [a=Rob Brown] and [a=Sean Booth].',
        profile_tokens: profileTokens,
        image_url: 'https://i.discogs.com/autechre.jpg',
        name_variations: [],
        aliases: [],
        members: [
          { id: 100, name: 'Rob Brown', active: true },
          { id: 101, name: 'Sean Booth', active: true },
        ],
        urls: ['https://en.wikipedia.org/wiki/Autechre', 'https://autechre.ws'],
        cached: false,
      });

      const req = { query: { artistId: '3840' } } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsArtistId).toBe(3840);
      expect(result.bio).toBe(
        'Autechre is a British electronic music duo consisting of [a=Rob Brown] and [a=Sean Booth].'
      );
      expect(result.bioTokens).toEqual(profileTokens);
      expect(result.wikipediaUrl).toBe('https://en.wikipedia.org/wiki/Autechre');
      expect(result.imageUrl).toBe('https://i.discogs.com/autechre.jpg');
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    });

    it('returns null bioTokens when LML does not provide profile_tokens', async () => {
      mockGetArtistDetails.mockResolvedValue({
        artist_id: 456,
        name: 'Some Artist',
        profile: 'Bio text',
        profile_tokens: null,
        image_url: null,
        name_variations: [],
        aliases: [],
        members: [],
        urls: [],
        cached: false,
      });

      const req = { query: { artistId: '456' } } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.bioTokens).toBeNull();
    });

    it('returns null wikipediaUrl when no Wikipedia link in urls', async () => {
      mockGetArtistDetails.mockResolvedValue({
        artist_id: 456,
        name: 'Some Artist',
        profile: 'Bio text',
        image_url: null,
        name_variations: [],
        aliases: [],
        members: [],
        urls: ['https://someartist.bandcamp.com'],
        cached: false,
      });

      const req = { query: { artistId: '456' } } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.wikipediaUrl).toBeNull();
      expect(result.imageUrl).toBeNull();
    });

    it('rejects with LmlClientError when LML returns 404', async () => {
      const { LmlClientError } = await import('@wxyc/lml-client');
      mockGetArtistDetails.mockRejectedValue(new LmlClientError('Not found', 404));

      const req = { query: { artistId: '99999' } } as unknown as Request;
      const res = createMockRes();

      await expect(getArtistMetadata(req, res as Response, mockNext)).rejects.toThrow('Not found');
    });

    it('rejects with LmlClientError when LML is unreachable', async () => {
      const { LmlClientError } = await import('@wxyc/lml-client');
      mockGetArtistDetails.mockRejectedValue(new LmlClientError('Connection refused', 502));

      const req = { query: { artistId: '3840' } } as unknown as Request;
      const res = createMockRes();

      await expect(getArtistMetadata(req, res as Response, mockNext)).rejects.toThrow('Connection refused');
    });

    // --- Server-side response cache (BS#988) ---
    describe('server-side response cache (BS#988)', () => {
      it('serves an identical repeat request from cache without a second LML call', async () => {
        mockGetArtistDetails.mockResolvedValue({
          artist_id: 7001,
          name: 'Broadcast',
          profile: 'A British band.',
          profile_tokens: null,
          image_url: 'https://i.discogs.com/broadcast.jpg',
          name_variations: [],
          aliases: [],
          members: [],
          urls: [],
          cached: false,
        });

        const req = { query: { artistId: '7001' } } as unknown as Request;

        const firstRes = createMockRes();
        await getArtistMetadata(req, firstRes as Response, mockNext);
        expect(mockGetArtistDetails).toHaveBeenCalledTimes(1);

        const secondRes = createMockRes();
        await getArtistMetadata(req, secondRes as Response, mockNext);

        expect(mockGetArtistDetails).toHaveBeenCalledTimes(1);
        expect(secondRes.status).toHaveBeenCalledWith(200);
        const secondResult = (secondRes.json as jest.Mock).mock.calls[0][0];
        expect(secondResult.discogsArtistId).toBe(7001);
      });

      it('negative-caches a confirmed 404: a repeat request rejects without re-invoking LML', async () => {
        const { LmlClientError } = await import('@wxyc/lml-client');
        mockGetArtistDetails.mockRejectedValue(new LmlClientError('Not found', 404));

        const req = { query: { artistId: '404404' } } as unknown as Request;

        await expect(getArtistMetadata(req, createMockRes() as Response, mockNext)).rejects.toThrow();
        expect(mockGetArtistDetails).toHaveBeenCalledTimes(1);

        await expect(getArtistMetadata(req, createMockRes() as Response, mockNext)).rejects.toThrow('not found');
        // The second (cached) rejection never re-consults LML.
        expect(mockGetArtistDetails).toHaveBeenCalledTimes(1);
      });

      it('does not negative-cache a transient failure: a repeat request re-invokes LML', async () => {
        // Mirrors the #1089 rule: only a confirmed absence (404) is
        // negatively cached, never a timeout/5xx/network blip.
        const { LmlClientError } = await import('@wxyc/lml-client');
        mockGetArtistDetails.mockRejectedValue(new LmlClientError('LML request timed out', 504));

        const req = { query: { artistId: '504504' } } as unknown as Request;

        await expect(getArtistMetadata(req, createMockRes() as Response, mockNext)).rejects.toThrow(
          'LML request timed out'
        );
        await expect(getArtistMetadata(req, createMockRes() as Response, mockNext)).rejects.toThrow(
          'LML request timed out'
        );

        expect(mockGetArtistDetails).toHaveBeenCalledTimes(2);
      });

      it('projects cache_hit onto the Sentry span', async () => {
        mockGetArtistDetails.mockResolvedValue({
          artist_id: 8001,
          name: 'Stereolab',
          profile: null,
          profile_tokens: null,
          image_url: null,
          name_variations: [],
          aliases: [],
          members: [],
          urls: [],
          cached: false,
        });

        const req = { query: { artistId: '8001' } } as unknown as Request;

        await getArtistMetadata(req, createMockRes() as Response, mockNext);
        // BS#989: chokepoint cache-stats projection (replaces the old
        // `proxy.metadata.artist.cache_hit`-only attribute).
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: false,
          cache_name: 'metadata_artist',
          cache_size: 1,
          cache_capacity: 2000,
        });

        await getArtistMetadata(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: true,
          cache_name: 'metadata_artist',
          cache_size: 1,
          cache_capacity: 2000,
        });
      });
    });
  });

  // --- resolveEntity ---

  describe('resolveEntity', () => {
    beforeEach(() => {
      // BS#988: reset the response cache between tests — the artist/3840
      // type+id pair is reused across a success case and a rejection case
      // below, which would otherwise short-circuit on a cached hit.
      __resetEntityResolveCacheForTests();
    });

    it('throws WxycError 400 when type or id is missing', async () => {
      const req = { query: { type: 'artist' } } as unknown as Request;
      const res = createMockRes();

      await expect(resolveEntity(req, res as Response, mockNext)).rejects.toThrow(
        'type and id query parameters are required'
      );
    });

    it('throws WxycError 400 for invalid type', async () => {
      const req = { query: { type: 'label', id: '1' } } as unknown as Request;
      const res = createMockRes();

      await expect(resolveEntity(req, res as Response, mockNext)).rejects.toThrow('type must be one of');
    });

    it('throws WxycError 400 when id is not a number', async () => {
      const req = { query: { type: 'artist', id: 'abc' } } as unknown as Request;
      const res = createMockRes();

      await expect(resolveEntity(req, res as Response, mockNext)).rejects.toThrow('id must be an integer');
    });

    it('resolves an artist by ID via LML', async () => {
      mockResolveEntity.mockResolvedValue({ name: 'Autechre', type: 'artist', id: 3840 });

      const req = { query: { type: 'artist', id: '3840' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(mockResolveEntity).toHaveBeenCalledWith('artist', 3840);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ name: 'Autechre', type: 'artist', id: 3840 });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
    });

    it('resolves a release by ID via LML', async () => {
      mockResolveEntity.mockResolvedValue({ name: 'Confield', type: 'release', id: 55555 });

      const req = { query: { type: 'release', id: '55555' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ name: 'Confield', type: 'release', id: 55555 });
    });

    it('resolves a master by ID via LML', async () => {
      mockResolveEntity.mockResolvedValue({ name: 'Confield', type: 'master', id: 44444 });

      const req = { query: { type: 'master', id: '44444' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ name: 'Confield', type: 'master', id: 44444 });
    });

    it('rejects with LmlClientError when LML returns not found', async () => {
      const { LmlClientError } = await import('@wxyc/lml-client');
      mockResolveEntity.mockRejectedValue(new LmlClientError('Not found', 404));

      const req = { query: { type: 'artist', id: '99999' } } as unknown as Request;
      const res = createMockRes();

      await expect(resolveEntity(req, res as Response, mockNext)).rejects.toThrow('Not found');
    });

    it('rejects with LmlClientError when LML times out', async () => {
      const { LmlClientError } = await import('@wxyc/lml-client');
      mockResolveEntity.mockRejectedValue(new LmlClientError('LML request timed out', 504));

      const req = { query: { type: 'artist', id: '3840' } } as unknown as Request;
      const res = createMockRes();

      await expect(resolveEntity(req, res as Response, mockNext)).rejects.toThrow('LML request timed out');
    });

    // --- Server-side response cache (BS#988) ---
    describe('server-side response cache (BS#988)', () => {
      it('serves an identical repeat request from cache without a second LML call', async () => {
        mockResolveEntity.mockResolvedValue({ name: 'Broadcast', type: 'artist', id: 7002 });

        const req = { query: { type: 'artist', id: '7002' } } as unknown as Request;

        const firstRes = createMockRes();
        await resolveEntity(req, firstRes as Response, mockNext);
        expect(mockResolveEntity).toHaveBeenCalledTimes(1);

        const secondRes = createMockRes();
        await resolveEntity(req, secondRes as Response, mockNext);

        expect(mockResolveEntity).toHaveBeenCalledTimes(1);
        expect(secondRes.json).toHaveBeenCalledWith({ name: 'Broadcast', type: 'artist', id: 7002 });
      });

      it('negative-caches a confirmed 404: a repeat request rejects without re-invoking LML', async () => {
        const { LmlClientError } = await import('@wxyc/lml-client');
        mockResolveEntity.mockRejectedValue(new LmlClientError('Not found', 404));

        const req = { query: { type: 'release', id: '404405' } } as unknown as Request;

        await expect(resolveEntity(req, createMockRes() as Response, mockNext)).rejects.toThrow();
        expect(mockResolveEntity).toHaveBeenCalledTimes(1);

        await expect(resolveEntity(req, createMockRes() as Response, mockNext)).rejects.toThrow('not found');
        expect(mockResolveEntity).toHaveBeenCalledTimes(1);
      });

      it('does not negative-cache a transient failure: a repeat request re-invokes LML', async () => {
        const { LmlClientError } = await import('@wxyc/lml-client');
        mockResolveEntity.mockRejectedValue(new LmlClientError('LML request timed out', 504));

        const req = { query: { type: 'master', id: '504505' } } as unknown as Request;

        await expect(resolveEntity(req, createMockRes() as Response, mockNext)).rejects.toThrow(
          'LML request timed out'
        );
        await expect(resolveEntity(req, createMockRes() as Response, mockNext)).rejects.toThrow(
          'LML request timed out'
        );

        expect(mockResolveEntity).toHaveBeenCalledTimes(2);
      });

      it('negative-caches a 404 with a short TTL, decoupled from the 24h positive TTL (BS#1893)', async () => {
        const { LmlClientError } = await import('@wxyc/lml-client');

        // A 404 mid discogs-cache-rebuild is transient-prone; its negative memo
        // must expire in minutes, not sit for the 24h positive TTL.
        mockResolveEntity.mockRejectedValueOnce(new LmlClientError('Not found', 404));
        const negReq = { query: { type: 'release', id: '909090' } } as unknown as Request;
        await expect(resolveEntity(negReq, createMockRes() as Response, mockNext)).rejects.toThrow();

        const negTtl = __getEntityResolveRemainingTtlForTests('release', 909090);
        expect(negTtl).toBeGreaterThan(0);
        // ~10 min (small slack for the sub-ms cache clock), and — the point of
        // the decoupling — far below the 24h positive TTL asserted just below.
        expect(negTtl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

        // A positive resolution keeps the long 24h TTL — proves the decoupling.
        mockResolveEntity.mockResolvedValueOnce({ name: 'Broadcast', type: 'artist', id: 7003 });
        const posReq = { query: { type: 'artist', id: '7003' } } as unknown as Request;
        await resolveEntity(posReq, createMockRes() as Response, mockNext);

        const posTtl = __getEntityResolveRemainingTtlForTests('artist', 7003);
        expect(posTtl).toBeGreaterThan(60 * 60 * 1000); // well over an hour
      });

      it('projects cache_hit onto the Sentry span', async () => {
        mockResolveEntity.mockResolvedValue({ name: 'Stereolab', type: 'artist', id: 8002 });

        const req = { query: { type: 'artist', id: '8002' } } as unknown as Request;

        await resolveEntity(req, createMockRes() as Response, mockNext);
        // BS#989: chokepoint cache-stats projection (replaces the old
        // `proxy.entity.resolve.cache_hit`-only attribute).
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: false,
          cache_name: 'entity_resolve',
          cache_size: 1,
          cache_capacity: 2000,
        });

        await resolveEntity(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: true,
          cache_name: 'entity_resolve',
          cache_size: 1,
          cache_capacity: 2000,
        });
      });
    });
  });

  // --- getSpotifyTrack ---

  describe('getSpotifyTrack', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
      process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
      // BS#988: reset the response cache between tests.
      __resetSpotifyTrackCacheForTests();
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('throws WxycError 400 when track ID is missing', async () => {
      const req = { params: {} } as unknown as Request;
      const res = createMockRes();

      await expect(getSpotifyTrack(req, res as Response, mockNext)).rejects.toThrow('Track ID is required');
    });

    it('returns 503 when Spotify credentials are not configured', async () => {
      delete process.env.SPOTIFY_CLIENT_ID;
      delete process.env.SPOTIFY_CLIENT_SECRET;

      const req = { params: { id: 'abc123' } } as unknown as Request;
      const res = createMockRes();

      await getSpotifyTrack(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns track metadata on success', async () => {
      // Mock token response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
      } as globalThis.Response);

      // Mock track response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            name: 'VI Scose Poise',
            artists: [{ name: 'Autechre' }],
            album: {
              name: 'Confield',
              images: [{ url: 'https://i.scdn.co/image/abc' }],
            },
          }),
      } as globalThis.Response);

      const req = { params: { id: '6LgJvl0Xdtc73RJ1mN1a7A' } } as unknown as Request;
      const res = createMockRes();

      await getSpotifyTrack(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        title: 'VI Scose Poise',
        artist: 'Autechre',
        album: 'Confield',
        artworkUrl: 'https://i.scdn.co/image/abc',
      });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('returns 404 when Spotify track not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
      } as globalThis.Response);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as globalThis.Response);

      const req = { params: { id: 'nonexistent' } } as unknown as Request;
      const res = createMockRes();

      await getSpotifyTrack(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 502 when Spotify auth fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as globalThis.Response);

      const req = { params: { id: 'abc123' } } as unknown as Request;
      const res = createMockRes();

      await getSpotifyTrack(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(502);
    });

    // --- Server-side response cache (BS#988) ---
    describe('server-side response cache (BS#988)', () => {
      it('serves an identical repeat request from cache without a second Spotify call', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
        } as globalThis.Response);
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              name: 'Tomorrow Never Knows',
              artists: [{ name: 'Broadcast' }],
              album: { name: 'Tender Buttons', images: [{ url: 'https://i.scdn.co/image/xyz' }] },
            }),
        } as globalThis.Response);

        const req = { params: { id: 'cache-hit-track-id' } } as unknown as Request;

        const firstRes = createMockRes();
        await getSpotifyTrack(req, firstRes as Response, mockNext);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        const secondRes = createMockRes();
        await getSpotifyTrack(req, secondRes as Response, mockNext);

        // No further fetch calls (token or track) — served entirely from cache.
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(secondRes.json).toHaveBeenCalledWith({
          title: 'Tomorrow Never Knows',
          artist: 'Broadcast',
          album: 'Tender Buttons',
          artworkUrl: 'https://i.scdn.co/image/xyz',
        });
      });

      it('negative-caches a confirmed 404: a repeat request short-circuits without re-invoking Spotify', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
        } as globalThis.Response);
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 } as globalThis.Response);

        const req = { params: { id: 'negative-cache-track-id' } } as unknown as Request;

        const firstRes = createMockRes();
        await getSpotifyTrack(req, firstRes as Response, mockNext);
        expect(firstRes.status).toHaveBeenCalledWith(404);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        const secondRes = createMockRes();
        await getSpotifyTrack(req, secondRes as Response, mockNext);

        expect(secondRes.status).toHaveBeenCalledWith(404);
        // No further fetch calls on the cached-negative repeat.
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('does not negative-cache a transient auth failure: a repeat request re-invokes Spotify', async () => {
        // Mirrors the #1089 rule: only a confirmed absence (404) is
        // negatively cached, never a transient upstream failure.
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401 } as globalThis.Response);
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401 } as globalThis.Response);

        const req = { params: { id: 'transient-failure-track-id' } } as unknown as Request;

        const firstRes = createMockRes();
        await getSpotifyTrack(req, firstRes as Response, mockNext);
        expect(firstRes.status).toHaveBeenCalledWith(502);

        const secondRes = createMockRes();
        await getSpotifyTrack(req, secondRes as Response, mockNext);
        expect(secondRes.status).toHaveBeenCalledWith(502);

        // Both requests independently hit Spotify — nothing was cached.
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('projects cache_hit onto the Sentry span', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
        } as globalThis.Response);
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              name: 'Track',
              artists: [{ name: 'Artist' }],
              album: { name: 'Album', images: [] },
            }),
        } as globalThis.Response);

        const req = { params: { id: 'sentry-cache-hit-track-id' } } as unknown as Request;

        await getSpotifyTrack(req, createMockRes() as Response, mockNext);
        // BS#989: chokepoint cache-stats projection (replaces the old
        // `proxy.spotify.track.cache_hit`-only attribute).
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: false,
          cache_name: 'spotify_track',
          cache_size: 1,
          cache_capacity: 2000,
        });

        await getSpotifyTrack(req, createMockRes() as Response, mockNext);
        expect(mockSpanSetAttributes).toHaveBeenCalledWith({
          cache_hit: true,
          cache_name: 'spotify_track',
          cache_size: 1,
          cache_capacity: 2000,
        });
      });
    });
  });

  describe('librarySearch', () => {
    it('throws WxycError 400 when no search params provided', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await expect(librarySearch(req, res as Response, mockNext)).rejects.toThrow(
        'At least one of artist, title, or q is required'
      );
    });

    it('forwards artist and title to LML searchLibrary', async () => {
      const mockResponse = {
        results: [{ id: 1, title: 'Aluminum Tunes', artist: 'Stereolab' }],
        total: 1,
        query: 'Stereolab',
      };
      mockSearchLibrary.mockResolvedValue(mockResponse);
      const req = { query: { artist: 'Stereolab', title: 'Aluminum Tunes', limit: '5' } } as unknown as Request;
      const res = createMockRes();

      await librarySearch(req, res as Response, mockNext);

      // BS#1826 PR 2: the PRD's protected-search win — `searchLibrary` now
      // carries the `proxy-library-search` class-1 label.
      expect(mockSearchLibrary).toHaveBeenCalledWith({
        artist: 'Stereolab',
        title: 'Aluminum Tunes',
        q: undefined,
        limit: 5,
        caller: 'proxy-library-search',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockResponse);
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=60');
    });

    it('forwards q param for free text search', async () => {
      mockSearchLibrary.mockResolvedValue({ results: [], total: 0, query: null });
      const req = { query: { q: 'Cat Power' } } as unknown as Request;
      const res = createMockRes();

      await librarySearch(req, res as Response, mockNext);

      expect(mockSearchLibrary).toHaveBeenCalledWith(expect.objectContaining({ q: 'Cat Power' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('degrades an LmlClientError to a 200 with empty results (class-1 never-5xx contract, BS#1826/#1819)', async () => {
      // Protected local catalog search must never surface a 5xx to dj-site
      // autocomplete: an LML timeout/abort/transport failure returns an empty
      // result set, not an error propagated to the errorHandler.
      mockSearchLibrary.mockRejectedValue(new MockLmlClientError('LML request timed out', 504));
      const req = { query: { q: 'Stereolab' } } as unknown as Request;
      const res = createMockRes();

      await librarySearch(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ results: [], total: 0, query: 'Stereolab' });
    });

    it('rejects with unexpected errors (handled by errorHandler)', async () => {
      const error = new Error('unexpected');
      mockSearchLibrary.mockRejectedValue(error);
      const req = { query: { artist: 'Stereolab' } } as unknown as Request;
      const res = createMockRes();

      await expect(librarySearch(req, res as Response, mockNext)).rejects.toThrow(error);
    });
  });

  // --- libraryTracks (E6-5 / BS#836) ---
  //
  // Composes BS `library_identity.discogs_release_id` (looked up by inbound
  // LML library.db.id) → LML `GET /api/v1/discogs/release/{id}` for the
  // tracklist. Returns an empty `tracks` array when identity is unresolved,
  // so the dj-site flowsheet picker can degrade to free-text input.

  describe('libraryTracks', () => {
    beforeEach(() => {
      __resetLibraryTracksCacheForTests();
    });

    it('throws WxycError 400 when libraryId is not a positive integer', async () => {
      const req = { params: { libraryId: 'not-a-number' } } as unknown as Request;
      const res = createMockRes();

      await expect(libraryTracks(req, res as Response, mockNext)).rejects.toThrow(
        'libraryId must be a positive integer'
      );
    });

    it('returns tracklist with mapped fields when identity is found and LML returns the release', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockResolvedValue({
        release_id: 42,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        tracklist: [
          { position: 'A1', title: 'Wrong Hand', duration: '3:42', artists: [] },
          { position: 'A2', title: 'Game That I Play', duration: '4:01', artists: [] },
          { position: 'B1', title: 'Back, Baby', duration: '4:38', artists: [] },
        ],
      });

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      const res = createMockRes();

      await libraryTracks(req, res as Response, mockNext);

      expect(mockGetDiscogsReleaseIdByLegacyId).toHaveBeenCalledWith(12345);
      expect(mockGetRelease).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        library_id: 12345,
        discogs_release_id: 42,
        source: 'discogs',
        tracks: [
          { position: 'A1', title: 'Wrong Hand', artist_credit: 'Jessica Pratt', duration_ms: 222000 },
          { position: 'A2', title: 'Game That I Play', artist_credit: 'Jessica Pratt', duration_ms: 241000 },
          { position: 'B1', title: 'Back, Baby', artist_credit: 'Jessica Pratt', duration_ms: 278000 },
        ],
      });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('prefers per-track artist credits over release-level artist (compilation case)', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(99);
      mockGetRelease.mockResolvedValue({
        release_id: 99,
        title: 'Edits',
        artist: 'Various',
        tracklist: [
          {
            position: '1',
            title: 'Call Your Name',
            duration: '5:23',
            artists: ['Chuquimamani-Condori'],
          },
        ],
      });

      const req = { params: { libraryId: '777' } } as unknown as Request;
      const res = createMockRes();

      await libraryTracks(req, res as Response, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          tracks: [
            { position: '1', title: 'Call Your Name', artist_credit: 'Chuquimamani-Condori', duration_ms: 323000 },
          ],
        })
      );
    });

    it('returns 200 + empty tracks when no identity is resolved', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(null);

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      const res = createMockRes();

      await libraryTracks(req, res as Response, mockNext);

      expect(mockGetRelease).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        library_id: 12345,
        discogs_release_id: null,
        source: null,
        tracks: [],
      });
    });

    it('returns 200 + empty tracks when LML 404s on the release id', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockRejectedValue(new MockLmlClientError('LML responded with 404: Not Found', 404));

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      const res = createMockRes();

      await libraryTracks(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        library_id: 12345,
        discogs_release_id: 42,
        source: 'discogs',
        tracks: [],
      });
    });

    it('caches LML 404 results so repeat lookups do not re-hit LML', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockRejectedValue(new MockLmlClientError('LML responded with 404: Not Found', 404));

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      await libraryTracks(req, createMockRes() as Response, mockNext);
      await libraryTracks(req, createMockRes() as Response, mockNext);

      expect(mockGetDiscogsReleaseIdByLegacyId).toHaveBeenCalledTimes(2);
      expect(mockGetRelease).toHaveBeenCalledTimes(1);
    });

    it('rebubbles LML 5xx errors (handled by errorHandler)', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockRejectedValue(new MockLmlClientError('LML responded with 503', 502));

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      const res = createMockRes();

      await expect(libraryTracks(req, res as Response, mockNext)).rejects.toThrow('LML responded with 503');
    });

    it('serves a repeat lookup from the BS-side cache without hitting LML twice', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockResolvedValue({
        release_id: 42,
        title: 'DOGA',
        artist: 'Juana Molina',
        tracklist: [{ position: '5', title: 'la paradoja', duration: '4:12', artists: [] }],
      });

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      await libraryTracks(req, createMockRes() as Response, mockNext);
      await libraryTracks(req, createMockRes() as Response, mockNext);

      expect(mockGetDiscogsReleaseIdByLegacyId).toHaveBeenCalledTimes(2);
      expect(mockGetRelease).toHaveBeenCalledTimes(1);
    });

    it('treats H:MM:SS and bare seconds in duration strings; null when unparseable', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockResolvedValue({
        release_id: 42,
        title: 'Live in Sentimental Mood',
        artist: 'Duke Ellington & John Coltrane',
        tracklist: [
          { position: '1', title: 'Long Side', duration: '1:02:03', artists: [] },
          { position: '2', title: 'Short', duration: '45', artists: [] },
          { position: '3', title: 'Mystery', duration: '', artists: [] },
          { position: '4', title: 'Garbage', duration: 'about five', artists: [] },
        ],
      });

      const req = { params: { libraryId: '12345' } } as unknown as Request;
      const res = createMockRes();

      await libraryTracks(req, res as Response, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          tracks: [
            {
              position: '1',
              title: 'Long Side',
              artist_credit: 'Duke Ellington & John Coltrane',
              duration_ms: 3723000,
            },
            { position: '2', title: 'Short', artist_credit: 'Duke Ellington & John Coltrane', duration_ms: 45000 },
            { position: '3', title: 'Mystery', artist_credit: 'Duke Ellington & John Coltrane', duration_ms: null },
            { position: '4', title: 'Garbage', artist_credit: 'Duke Ellington & John Coltrane', duration_ms: null },
          ],
        })
      );
    });

    it('projects cache_name="tracklist" onto the Sentry span for hit and miss (BS#989)', async () => {
      mockGetDiscogsReleaseIdByLegacyId.mockResolvedValue(42);
      mockGetRelease.mockResolvedValue({
        release_id: 42,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        tracklist: [{ position: 'A1', title: 'Wrong Hand', duration: '3:42', artists: [] }],
      });

      const req = { params: { libraryId: '12345' } } as unknown as Request;

      await libraryTracks(req, createMockRes() as Response, mockNext);
      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        cache_hit: false,
        cache_name: 'tracklist',
        cache_size: 1,
        cache_capacity: 500,
      });

      await libraryTracks(req, createMockRes() as Response, mockNext);
      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        cache_hit: true,
        cache_name: 'tracklist',
        cache_size: 1,
        cache_capacity: 500,
      });
    });
  });
});
