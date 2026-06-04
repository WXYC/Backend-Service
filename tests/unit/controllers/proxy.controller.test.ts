/**
 * Unit tests for the proxy controller.
 *
 * Handlers that are rerouted through library-metadata-lookup (LML) mock the
 * LML client. The Spotify handler still mocks global fetch directly.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

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

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  getRelease: mockGetRelease,
  getArtistDetails: mockGetArtistDetails,
  resolveEntity: mockResolveEntity,
  searchLibrary: mockSearchLibrary,
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: MockLmlClientError,
}));

// Backend code paths now route through the LmlLookupCoordinator (BS#885).
jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: mockLookupMetadata },
}));

// BS#1331: getAlbumMetadata now consults local persisted state first via
// `lookupAlbumMetadataByKey` before falling through to LML. Mocked here so
// each test can set local-hit, catch-arm-row, or cold-miss explicitly.
const mockLookupAlbumMetadataByKey = jest.fn<(artist: string, release?: string) => Promise<unknown>>();
jest.mock('../../../apps/backend/services/album-metadata-lookup.service', () => ({
  lookupAlbumMetadataByKey: mockLookupAlbumMetadataByKey,
}));

// BS#1331 acceptance: the cohort split for trace explorer turns on
// `proxy.metadata.album.upstream_calls`. Mock Sentry's `getActiveSpan` so
// the cache-first test can assert the attribute lands as a number; outside
// a tracing context `getActiveSpan()` is null and the call short-circuits.
const mockSpanSetAttributes = jest.fn();
const mockGetActiveSpan = jest.fn(() => ({ setAttributes: mockSpanSetAttributes }));
jest.mock('@sentry/node', () => ({
  getActiveSpan: mockGetActiveSpan,
}));

// library.service mock — only the helper libraryTracks consumes.
const mockGetDiscogsReleaseIdByLegacyId = jest.fn<(legacyId: number) => Promise<number | null>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  getDiscogsReleaseIdByLegacyId: mockGetDiscogsReleaseIdByLegacyId,
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

// LRU cache mock (proxy controller uses it for artwork caching)
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
  });

  // --- getAlbumMetadata ---

  describe('getAlbumMetadata', () => {
    beforeEach(() => {
      // Default to cold case: no local row, so existing tests fall through
      // to LML. Local-hit tests override below. BS#1331.
      mockLookupAlbumMetadataByKey.mockResolvedValue(null);
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
        expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield', undefined, {
          budgetMs: 5000,
          caller: 'proxy-album-metadata',
        });
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
        mockLookupAlbumMetadataByKey.mockResolvedValue({
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

        expect(mockLookupAlbumMetadataByKey).toHaveBeenCalledWith('Cached Artist', 'Cached Album');
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
        mockLookupAlbumMetadataByKey.mockResolvedValue({
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
        mockLookupAlbumMetadataByKey.mockResolvedValue({
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
        mockLookupAlbumMetadataByKey.mockResolvedValue({
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
        mockLookupAlbumMetadataByKey.mockRejectedValue(new Error('asyncpg: connection refused'));
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
        mockLookupAlbumMetadataByKey.mockResolvedValue(null);
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

        expect(mockLookupAlbumMetadataByKey).toHaveBeenCalledWith('Cold Artist', 'Cold Album');
        // LML was consulted because the local lookup returned null.
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
        mockLookupAlbumMetadataByKey.mockResolvedValue({
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
  });

  // --- getArtistMetadata ---

  describe('getArtistMetadata', () => {
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
  });

  // --- resolveEntity ---

  describe('resolveEntity', () => {
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
  });

  // --- getSpotifyTrack ---

  describe('getSpotifyTrack', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
      process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
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

      expect(mockSearchLibrary).toHaveBeenCalledWith({
        artist: 'Stereolab',
        title: 'Aluminum Tunes',
        q: undefined,
        limit: 5,
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

    it('rejects with LmlClientError (handled by errorHandler)', async () => {
      mockSearchLibrary.mockRejectedValue(new MockLmlClientError('LML not configured', 503));
      const req = { query: { artist: 'Stereolab' } } as unknown as Request;
      const res = createMockRes();

      await expect(librarySearch(req, res as Response, mockNext)).rejects.toThrow('LML not configured');
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
  });
});
