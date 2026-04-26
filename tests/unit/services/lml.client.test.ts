/**
 * Unit tests for the LML (library-metadata-lookup) HTTP client.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import {
  lookupMetadata,
  getRelease,
  getArtistDetails,
  resolveEntity,
  LmlClientError,
  checkStreamingAvailability,
  searchLibrary,
} from '../../../apps/backend/services/lml/lml.client';

describe('lml.client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('lookupMetadata', () => {
    it('sends POST to /api/v1/lookup with artist, album, and song', async () => {
      const mockResponse = { results: [], search_type: 'none', song_not_found: false, found_on_compilation: false };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield', 'VI Scose Poise');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/lookup',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artist: 'Autechre', album: 'Confield', song: 'VI Scose Poise' }),
        })
      );
    });

    it('omits album and song when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/lookup',
        expect.objectContaining({
          body: JSON.stringify({ artist: 'Autechre' }),
        })
      );
    });

    it('does not include raw_message in the request body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody).not.toHaveProperty('raw_message');
    });
  });

  describe('getRelease', () => {
    it('sends GET to /api/v1/discogs/release/{id}', async () => {
      const mockRelease = { release_id: 123, title: 'Confield', artist: 'Autechre' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRelease),
      } as unknown as globalThis.Response);

      const result = await getRelease(123);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/discogs/release/123',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual(mockRelease);
    });
  });

  describe('getArtistDetails', () => {
    it('sends GET to /api/v1/discogs/artist/{id}', async () => {
      const mockArtist = { artist_id: 3840, name: 'Autechre', profile: 'Electronic duo' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockArtist),
      } as unknown as globalThis.Response);

      const result = await getArtistDetails(3840);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/discogs/artist/3840',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual(mockArtist);
    });
  });

  describe('resolveEntity', () => {
    it('sends GET to /api/v1/discogs/entity/{type}/{id}', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'Autechre', type: 'artist', id: 3840 }),
      } as unknown as globalThis.Response);

      const result = await resolveEntity('artist', 3840);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/discogs/entity/artist/3840',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual({ name: 'Autechre', type: 'artist', id: 3840 });
    });
  });

  describe('error handling', () => {
    it('throws LmlClientError with 503 when LIBRARY_METADATA_URL is not set', async () => {
      delete process.env.LIBRARY_METADATA_URL;

      await expect(lookupMetadata('Autechre')).rejects.toThrow(LmlClientError);
      await expect(lookupMetadata('Autechre')).rejects.toMatchObject({ statusCode: 503 });
    });

    it('throws LmlClientError with mapped status on non-2xx response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as unknown as globalThis.Response);

      await expect(getArtistDetails(99999)).rejects.toThrow(LmlClientError);
      await expect(getArtistDetails(99999)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('maps LML 5xx errors to 502', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as globalThis.Response);

      await expect(getRelease(123)).rejects.toMatchObject({ statusCode: 502 });
    });

    it('throws LmlClientError with 502 on network failure', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(resolveEntity('artist', 3840)).rejects.toThrow(LmlClientError);
      await expect(resolveEntity('artist', 3840)).rejects.toMatchObject({ statusCode: 502 });
    });

    it('strips trailing slash from LIBRARY_METADATA_URL', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockFetch).toHaveBeenCalledWith('http://lml.test:8000/api/v1/lookup', expect.anything());
    });

    it('does not double the /api/v1 prefix when LIBRARY_METADATA_URL already includes it', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/api/v1';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('/api/v1/api/v1');
      expect(calledUrl).toBe('http://lml.test:8000/api/v1/lookup');
    });
  });

  describe('checkStreamingAvailability', () => {
    it('sends POST to /api/v1/streaming-check with artist and title', async () => {
      const mockResponse = {
        on_streaming: true,
        sources: {
          spotify: { url: 'https://open.spotify.com/album/abc', confidence: 95.0 },
          deezer: null,
          apple_music: null,
          bandcamp: null,
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as unknown as globalThis.Response);

      const result = await checkStreamingAvailability('Stereolab', 'Aluminum Tunes');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/streaming-check',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artist: 'Stereolab', title: 'Aluminum Tunes' }),
        })
      );
      expect(result.on_streaming).toBe(true);
      expect(result.sources.spotify?.url).toBe('https://open.spotify.com/album/abc');
    });

    it('returns on_streaming=false when not found', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            on_streaming: false,
            sources: { spotify: null, deezer: null, apple_music: null, bandcamp: null },
          }),
      } as unknown as globalThis.Response);

      const result = await checkStreamingAvailability('Chuquimamani-Condori', 'Edits');

      expect(result.on_streaming).toBe(false);
    });

    it('throws LmlClientError on non-2xx response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as globalThis.Response);

      await expect(checkStreamingAvailability('Stereolab', 'Aluminum Tunes')).rejects.toThrow(LmlClientError);
    });
  });

  describe('searchLibrary', () => {
    it('sends GET to /api/v1/library/search with query params', async () => {
      const mockResponse = {
        results: [{ id: 1, title: 'Aluminum Tunes', artist: 'Stereolab' }],
        total: 1,
        query: 'Stereolab',
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as unknown as globalThis.Response);

      const result = await searchLibrary({ artist: 'Stereolab', limit: 5 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/library/search?'),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('artist=Stereolab');
      expect(calledUrl).toContain('limit=5');
      expect(result.total).toBe(1);
    });

    it('omits unset params', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], total: 0, query: null }),
      } as unknown as globalThis.Response);

      await searchLibrary({ title: 'Moon Pix' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('title=Moon+Pix');
      expect(calledUrl).not.toContain('artist=');
      expect(calledUrl).not.toContain('limit=');
    });
  });
});
