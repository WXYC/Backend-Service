/**
 * Unit tests for the proxy controller.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// --- Mocks ---

const mockFind = jest.fn<() => Promise<{
  artworkUrl: string | null;
  releaseUrl: string | null;
  album: string | null;
  artist: string | null;
  source: string | null;
  confidence: number;
}>>();

jest.mock('../../../apps/backend/services/artwork/finder', () => ({
  getArtworkFinder: () => ({ find: mockFind }),
}));

const mockFetchAlbumMetadata = jest.fn<() => Promise<{
  discogsReleaseId?: number;
  discogsUrl?: string;
  releaseYear?: number;
  artworkUrl?: string;
} | null>>();
const mockFetchArtistMetadataById = jest.fn<() => Promise<{
  discogsArtistId?: number;
  bio?: string;
  wikipediaUrl?: string;
} | null>>();

jest.mock('../../../apps/backend/services/metadata/providers/discogs.provider', () => ({
  DiscogsProvider: jest.fn().mockImplementation(() => ({
    fetchAlbumMetadata: mockFetchAlbumMetadata,
    fetchArtistMetadataById: mockFetchArtistMetadataById,
  })),
}));

const mockGetSpotifyUrl = jest.fn<() => Promise<string | null>>();

jest.mock('../../../apps/backend/services/metadata/providers/spotify.provider', () => ({
  SpotifyProvider: jest.fn().mockImplementation(() => ({
    getSpotifyUrl: mockGetSpotifyUrl,
  })),
}));

const mockGetAppleMusicUrl = jest.fn<() => Promise<string | null>>();

jest.mock('../../../apps/backend/services/metadata/providers/apple.provider', () => ({
  AppleMusicProvider: jest.fn().mockImplementation(() => ({
    getAppleMusicUrl: mockGetAppleMusicUrl,
  })),
}));

jest.mock('../../../apps/backend/services/metadata/providers/search-urls.provider', () => ({
  SearchUrlProvider: jest.fn().mockImplementation(() => ({
    getAllSearchUrls: (artist: string, album?: string, track?: string) => ({
      youtubeMusicUrl: `https://music.youtube.com/search?q=${encodeURIComponent(artist)}`,
      bandcampUrl: `https://bandcamp.com/search?q=${encodeURIComponent(artist)}`,
      soundcloudUrl: `https://soundcloud.com/search?q=${encodeURIComponent(artist)}`,
    }),
  })),
}));

const mockGetArtist = jest.fn<() => Promise<{ id: number; name: string } | null>>();
const mockGetRelease = jest.fn<() => Promise<{ title: string } | null>>();
const mockGetMaster = jest.fn<() => Promise<{ title: string } | null>>();

jest.mock('../../../apps/backend/services/discogs/discogs.service', () => ({
  DiscogsService: {
    getArtist: mockGetArtist,
    getRelease: mockGetRelease,
    getMaster: mockGetMaster,
  },
}));

// Mock global fetch for Spotify track endpoint
const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import {
  searchArtwork,
  getAlbumMetadata,
  getArtistMetadata,
  resolveEntity,
  getSpotifyTrack,
} from '../../../apps/backend/controllers/proxy.controller';

// --- Helpers ---

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.set = jest.fn().mockReturnValue(res) as unknown as Response['set'];
  return res;
};

describe('proxy.controller', () => {
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn() as unknown as NextFunction;
  });

  // --- searchArtwork ---

  describe('searchArtwork', () => {
    it('returns 400 when artistName is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await searchArtwork(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'artistName query parameter is required' });
    });

    it('returns artwork result with cache header', async () => {
      mockFind.mockResolvedValue({
        artworkUrl: 'https://i.discogs.com/img.jpg',
        releaseUrl: 'https://discogs.com/release/123',
        album: 'OK Computer',
        artist: 'Radiohead',
        source: 'discogs',
        confidence: 0.95,
      });

      const req = { query: { artistName: 'Radiohead', releaseTitle: 'OK Computer' } } as unknown as Request;
      const res = createMockRes();

      await searchArtwork(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        artworkUrl: 'https://i.discogs.com/img.jpg',
        source: 'discogs',
        confidence: 0.95,
      });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('calls next on error', async () => {
      const error = new Error('Service failure');
      mockFind.mockRejectedValue(error);

      const req = { query: { artistName: 'Test' } } as unknown as Request;
      const res = createMockRes();

      await searchArtwork(req, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // --- getAlbumMetadata ---

  describe('getAlbumMetadata', () => {
    it('returns 400 when artistName is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns merged metadata from all providers', async () => {
      mockFetchAlbumMetadata.mockResolvedValue({
        discogsReleaseId: 12345,
        discogsUrl: 'https://www.discogs.com/release/12345',
        releaseYear: 1997,
        artworkUrl: 'https://i.discogs.com/art.jpg',
      });
      mockGetSpotifyUrl.mockResolvedValue('https://open.spotify.com/track/abc');
      mockGetAppleMusicUrl.mockResolvedValue('https://music.apple.com/album/xyz');

      const req = {
        query: { artistName: 'Radiohead', releaseTitle: 'OK Computer', trackTitle: 'Paranoid Android' },
      } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.discogsReleaseId).toBe(12345);
      expect(result.spotifyUrl).toBe('https://open.spotify.com/track/abc');
      expect(result.appleMusicUrl).toBe('https://music.apple.com/album/xyz');
      expect(result.youtubeMusicUrl).toContain('music.youtube.com');
      expect(result.bandcampUrl).toContain('bandcamp.com');
      expect(result.soundcloudUrl).toContain('soundcloud.com');
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('returns partial metadata when some providers fail', async () => {
      mockFetchAlbumMetadata.mockRejectedValue(new Error('Discogs down'));
      mockGetSpotifyUrl.mockResolvedValue('https://open.spotify.com/track/abc');
      mockGetAppleMusicUrl.mockResolvedValue(null);

      const req = { query: { artistName: 'Test Artist' } } as unknown as Request;
      const res = createMockRes();

      await getAlbumMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result.spotifyUrl).toBe('https://open.spotify.com/track/abc');
      expect(result.discogsReleaseId).toBeUndefined();
    });
  });

  // --- getArtistMetadata ---

  describe('getArtistMetadata', () => {
    it('returns 400 when artistId is missing', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'artistId query parameter is required' });
    });

    it('returns 400 when artistId is not a number', async () => {
      const req = { query: { artistId: 'abc' } } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'artistId must be an integer' });
    });

    it('returns 404 when artist not found', async () => {
      mockFetchArtistMetadataById.mockResolvedValue(null);

      const req = { query: { artistId: '99999' } } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns artist metadata with cache header', async () => {
      mockFetchArtistMetadataById.mockResolvedValue({
        discogsArtistId: 456,
        bio: 'A great band',
        wikipediaUrl: 'https://en.wikipedia.org/wiki/Test',
      });

      const req = { query: { artistId: '456' } } as unknown as Request;
      const res = createMockRes();

      await getArtistMetadata(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        discogsArtistId: 456,
        bio: 'A great band',
        wikipediaUrl: 'https://en.wikipedia.org/wiki/Test',
      });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    });
  });

  // --- resolveEntity ---

  describe('resolveEntity', () => {
    it('returns 400 when type or id is missing', async () => {
      const req = { query: { type: 'artist' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for invalid type', async () => {
      const req = { query: { type: 'label', id: '1' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('artist, release, master') })
      );
    });

    it('returns 400 when id is not a number', async () => {
      const req = { query: { type: 'artist', id: 'abc' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'id must be an integer' });
    });

    it('resolves an artist by ID', async () => {
      mockGetArtist.mockResolvedValue({ id: 3840, name: 'Radiohead' });

      const req = { query: { type: 'artist', id: '3840' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ name: 'Radiohead', type: 'artist', id: 3840 });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
    });

    it('resolves a release by ID', async () => {
      mockGetRelease.mockResolvedValue({ title: 'OK Computer' });

      const req = { query: { type: 'release', id: '55555' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ name: 'OK Computer', type: 'release', id: 55555 });
    });

    it('resolves a master by ID', async () => {
      mockGetMaster.mockResolvedValue({ title: 'Kid A' });

      const req = { query: { type: 'master', id: '44444' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ name: 'Kid A', type: 'master', id: 44444 });
    });

    it('returns 404 when entity not found', async () => {
      mockGetArtist.mockResolvedValue(null);

      const req = { query: { type: 'artist', id: '99999' } } as unknown as Request;
      const res = createMockRes();

      await resolveEntity(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
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

    it('returns 400 when track ID is missing', async () => {
      const req = { params: {} } as unknown as Request;
      const res = createMockRes();

      await getSpotifyTrack(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
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
        json: async () => ({ access_token: 'mock-token', expires_in: 3600 }),
      } as globalThis.Response);

      // Mock track response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: 'Everything In Its Right Place',
          artists: [{ name: 'Radiohead' }],
          album: {
            name: 'Kid A',
            images: [{ url: 'https://i.scdn.co/image/abc' }],
          },
        }),
      } as globalThis.Response);

      const req = { params: { id: '6LgJvl0Xdtc73RJ1mN1a7A' } } as unknown as Request;
      const res = createMockRes();

      await getSpotifyTrack(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        title: 'Everything In Its Right Place',
        artist: 'Radiohead',
        album: 'Kid A',
        artworkUrl: 'https://i.scdn.co/image/abc',
      });
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=600');
    });

    it('returns 404 when Spotify track not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'mock-token', expires_in: 3600 }),
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
});
