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

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  getRelease: mockGetRelease,
  getArtistDetails: mockGetArtistDetails,
  resolveEntity: mockResolveEntity,
  searchLibrary: mockSearchLibrary,
  LmlClientError: MockLmlClientError,
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
    it('throws WxycError 400 when artistName is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await expect(getAlbumMetadata(req, res as Response, mockNext)).rejects.toThrow(
        'artistName query parameter is required'
      );
    });

    it('returns merged metadata from LML lookup + release details', async () => {
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
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      mockGetRelease.mockResolvedValue({
        release_id: 12345,
        title: 'Confield',
        artist: 'Autechre',
        year: 2001,
        label: 'Warp',
        artist_id: 3840,
        genres: ['Electronic'],
        styles: ['IDM', 'Abstract'],
        tracklist: [
          { position: '1', title: 'VI Scose Poise', duration: '6:45', artists: [] },
          { position: '2', title: 'Cfern', duration: '7:01', artists: [] },
        ],
        artwork_url: 'https://i.discogs.com/art.jpg',
        release_url: 'https://www.discogs.com/release/12345',
        released: '2001-04-30',
        cached: false,
        artists: [{ artist_id: 3840, name: 'Autechre', join: '', role: null }],
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

    it('returns fallback search URLs when LML search fails', async () => {
      mockLookupMetadata.mockRejectedValue(new Error('LML down'));

      const req = { query: { artistName: 'Test Artist', releaseTitle: 'Test Album' } } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBeUndefined();
      expect(result.spotifyUrl).toBeUndefined();
      expect(result.appleMusicUrl).toBeUndefined();
      // Search URLs are always constructed as fallback
      expect(result.youtubeMusicUrl).toContain('music.youtube.com');
      expect(result.bandcampUrl).toContain('bandcamp.com');
      expect(result.soundcloudUrl).toContain('soundcloud.com');
    });

    it('returns search-only metadata when release fetch fails', async () => {
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

      mockGetRelease.mockRejectedValue(new Error('Release fetch failed'));

      const req = {
        query: { artistName: 'Cat Power', releaseTitle: 'Moon Pix' },
      } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBe(99999);
      expect(result.artworkUrl).toBe('https://i.discogs.com/art.jpg');
      // Streaming URLs from search result still present
      expect(result.spotifyUrl).toBe('https://open.spotify.com/album/moonpix');
      // No enriched fields since release fetch failed
      expect(result.genres).toBeUndefined();
      expect(result.tracklist).toBeUndefined();
    });

    it('strips Discogs spacer.gif placeholder from artworkUrl (#649)', async () => {
      // The iOS playcut-detail endpoint returns artworkUrl directly to the
      // client. Discogs occasionally sends spacer.gif as a placeholder when a
      // release has no real cover art; passing that through results in a
      // broken/blank image on iOS. Drop it at this callsite the same way
      // metadata.service.ts does.
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
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      mockGetRelease.mockResolvedValue({
        release_id: 7777,
        title: 'On Your Own Love Again',
        artist: 'Jessica Pratt',
        year: 2015,
        label: 'Drag City',
        artist_id: 5555,
        genres: ['Rock'],
        styles: [],
        tracklist: [],
        artwork_url: 'https://s.discogs.com/images/spacer.gif',
        release_url: 'https://www.discogs.com/release/7777',
        released: '2015-02-03',
        cached: false,
        artists: [{ artist_id: 5555, name: 'Jessica Pratt', join: '', role: null }],
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

    it('returns fallback search URLs when LML search returns empty results', async () => {
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
      expect(result.spotifyUrl).toBeUndefined();
      expect(result.appleMusicUrl).toBeUndefined();
      // Search URLs are constructed as fallback
      expect(result.youtubeMusicUrl).toContain('music.youtube.com');
      expect(result.youtubeMusicUrl).toContain('Obscure%20Artist');
      expect(result.bandcampUrl).toContain('bandcamp.com');
      expect(result.soundcloudUrl).toContain('soundcloud.com');
      expect(mockGetRelease).not.toHaveBeenCalled();
    });

    // --- Single-call path (PROXY_METADATA_SINGLE_LOOKUP=true) ---
    //
    // When the flag is on, `getAlbumMetadata` calls LML once with
    // `extended: true` and reads the release-detail fields off the lookup
    // response's `artwork` block. The follow-up `getRelease()` call goes
    // away. These tests pin the new path's contract; the legacy path's
    // tests above remain to cover the pre-cutover behavior.

    describe('PROXY_METADATA_SINGLE_LOOKUP=true', () => {
      const originalFlag = process.env.PROXY_METADATA_SINGLE_LOOKUP;

      beforeEach(() => {
        process.env.PROXY_METADATA_SINGLE_LOOKUP = 'true';
      });

      afterEach(() => {
        if (originalFlag === undefined) delete process.env.PROXY_METADATA_SINGLE_LOOKUP;
        else process.env.PROXY_METADATA_SINGLE_LOOKUP = originalFlag;
      });

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

        // Lookup was called with `extended: true` so LML knows to populate
        // the new fields.
        expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield', undefined, {
          extended: true,
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
      const { LmlClientError } = await import('../../../apps/backend/services/lml/lml.client');
      mockGetArtistDetails.mockRejectedValue(new LmlClientError('Not found', 404));

      const req = { query: { artistId: '99999' } } as unknown as Request;
      const res = createMockRes();

      await expect(getArtistMetadata(req, res as Response, mockNext)).rejects.toThrow('Not found');
    });

    it('rejects with LmlClientError when LML is unreachable', async () => {
      const { LmlClientError } = await import('../../../apps/backend/services/lml/lml.client');
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
      const { LmlClientError } = await import('../../../apps/backend/services/lml/lml.client');
      mockResolveEntity.mockRejectedValue(new LmlClientError('Not found', 404));

      const req = { query: { type: 'artist', id: '99999' } } as unknown as Request;
      const res = createMockRes();

      await expect(resolveEntity(req, res as Response, mockNext)).rejects.toThrow('Not found');
    });

    it('rejects with LmlClientError when LML times out', async () => {
      const { LmlClientError } = await import('../../../apps/backend/services/lml/lml.client');
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
});
