/**
 * Unit tests for the LML (library-metadata-lookup) HTTP client.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import {
  searchDiscogs,
  getRelease,
  getArtistDetails,
  resolveEntity,
  LmlClientError,
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

  describe('searchDiscogs', () => {
    it('sends POST to /api/v1/discogs/search with artist and album', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], total: 0, cached: false }),
      } as unknown as globalThis.Response);

      await searchDiscogs('Autechre', 'Confield');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/discogs/search',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artist: 'Autechre', album: 'Confield' }),
        })
      );
    });

    it('omits album when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], total: 0, cached: false }),
      } as unknown as globalThis.Response);

      await searchDiscogs('Autechre');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/discogs/search',
        expect.objectContaining({
          body: JSON.stringify({ artist: 'Autechre' }),
        })
      );
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

      await expect(searchDiscogs('Autechre')).rejects.toThrow(LmlClientError);
      await expect(searchDiscogs('Autechre')).rejects.toMatchObject({ statusCode: 503 });
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
        json: () => Promise.resolve({ results: [], total: 0, cached: false }),
      } as unknown as globalThis.Response);

      await searchDiscogs('Autechre');

      expect(mockFetch).toHaveBeenCalledWith('http://lml.test:8000/api/v1/discogs/search', expect.anything());
    });

    it('does not double the /api/v1 prefix when LIBRARY_METADATA_URL already includes it', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/api/v1';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], total: 0, cached: false }),
      } as unknown as globalThis.Response);

      await searchDiscogs('Autechre');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('/api/v1/api/v1');
      expect(calledUrl).toBe('http://lml.test:8000/api/v1/discogs/search');
    });
  });
});
