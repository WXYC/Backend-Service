/**
 * Unit tests for the LML (library-metadata-lookup) HTTP client.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

// Mock @sentry/node so we can assert span/setAttributes calls without
// initializing Sentry. startSpan(opts, callback) is implemented as a
// thin wrapper that invokes the callback with a span mock and returns
// the callback's result — preserving lookupMetadata's return value.
const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttributes: typeof mockSpanSetAttributes };
const mockStartSpan = jest.fn(
  async (_opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    await callback({ setAttributes: mockSpanSetAttributes })
);
jest.mock('@sentry/node', () => ({
  startSpan: (opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    mockStartSpan(opts, callback),
}));

import {
  lookupMetadata,
  lookupBySong,
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
    it('sends POST to /api/v1/lookup with artist, album, song, and synthesized raw_message', async () => {
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
          body: JSON.stringify({
            artist: 'Autechre',
            raw_message: 'Autechre - Confield - VI Scose Poise',
            album: 'Confield',
            song: 'VI Scose Poise',
          }),
        })
      );
    });

    it('omits album and song when not provided; raw_message falls back to the artist', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/lookup',
        expect.objectContaining({
          body: JSON.stringify({ artist: 'Autechre', raw_message: 'Autechre' }),
        })
      );
    });

    it('synthesizes raw_message from artist and album when song is omitted', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody.raw_message).toBe('Autechre - Confield');
    });

    it('forwards options.extended=true onto the request body', async () => {
      // The /proxy/metadata/album single-call path depends on this flag
      // making it onto the wire. Without it, LML's response would omit
      // the new release-detail fields and BS would silently degrade to
      // partial metadata.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield', undefined, { extended: true });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody.extended).toBe(true);
      // warm_cache stays absent when not requested.
      expect(callBody.warm_cache).toBeUndefined();
    });

    it('forwards options.warm_cache=true onto the request body', async () => {
      // flowsheet-linkage.service.ts depends on this flag making it onto
      // the wire so LML schedules the fire-and-forget bio warm. There's
      // no read-side observability for the warm task — if the key never
      // made it onto the body, the warm would silently never fire.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Stereolab', 'Aluminum Tunes', undefined, { warm_cache: true });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody.warm_cache).toBe(true);
      // extended stays absent when not requested.
      expect(callBody.extended).toBeUndefined();
    });

    it('omits both option flags from the body when no options are passed', async () => {
      // Read-path callers (request-line, artwork fallback, library
      // services) don't pass options. The body must stay byte-identical
      // to the pre-1.5 shape so legacy LML deploys keep working during
      // any rollback.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody.extended).toBeUndefined();
      expect(callBody.warm_cache).toBeUndefined();
    });

    it('wraps the call in a Sentry span and projects cache_stats onto it', async () => {
      const cache_stats = {
        memory_hits: 1,
        pg_hits: 4,
        pg_misses: 2,
        api_calls: 3,
        pg_time_ms: 7.5,
        api_time_ms: 250,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            search_type: 'none',
            song_not_found: false,
            found_on_compilation: false,
            cache_stats,
          }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield');

      // Span created with the contracted name + http.client op (so it shows
      // up under the BS transaction in Sentry's trace explorer).
      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockStartSpan.mock.calls[0][0]).toEqual({ name: 'lml.lookup', op: 'http.client' });

      // Each numeric cache_stats field becomes lml.cache.<key> on the span.
      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        'lml.cache.memory_hits': 1,
        'lml.cache.pg_hits': 4,
        'lml.cache.pg_misses': 2,
        'lml.cache.api_calls': 3,
        'lml.cache.pg_time_ms': 7.5,
        'lml.cache.api_time_ms': 250,
      });
    });

    it('does not call setAttributes when LML response omits cache_stats', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockSpanSetAttributes).not.toHaveBeenCalled();
    });

    it('does not call setAttributes when cache_stats is an array (defensive narrowing)', async () => {
      // Defensive narrowing: Object.entries([1, 2, 3]) yields [["0",1],["1",2],["2",3]],
      // which would otherwise project as junk attributes lml.cache.0=1, lml.cache.1=2, ...
      // Guard the projection to require a real plain object (not array, not scalar).
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            search_type: 'none',
            song_not_found: false,
            found_on_compilation: false,
            cache_stats: [1, 2, 3],
          }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockSpanSetAttributes).not.toHaveBeenCalled();
    });

    it('resolves successfully when span.setAttributes throws (observability must not break the request path)', async () => {
      // Wrapping in try/catch keeps lookupMetadata's contract: a Sentry/SDK bug
      // in setAttributes must not surface as a failed metadata lookup.
      const cache_stats = { memory_hits: 1, pg_hits: 4 };
      const lookupResponse = {
        results: [],
        search_type: 'none',
        song_not_found: false,
        found_on_compilation: false,
        cache_stats,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(lookupResponse),
      } as unknown as globalThis.Response);

      mockSpanSetAttributes.mockImplementation(() => {
        throw new Error('sentry boom');
      });

      const result = await lookupMetadata('Autechre');

      expect(result).toEqual(lookupResponse);
    });

    it('returns the LookupResponse intact when wrapped in a span', async () => {
      // Regression: the span wrapper must not swallow or alter the response payload.
      const lookupResponse = {
        results: [{ library_item: { id: 42 } }],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(lookupResponse),
      } as unknown as globalThis.Response);

      const result = await lookupMetadata('Autechre', 'Confield');

      expect(result).toEqual(lookupResponse);
    });
  });

  describe('lookupBySong', () => {
    it('sends POST to /api/v1/lookup with only song + raw_message (artist omitted)', async () => {
      // LML's SONG_AS_TRACK strategy is keyed off a song-only request; sending
      // an empty-string artist would bias LML's parser away from the strategy.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupBySong('Back, Baby');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://lml.test:8000/api/v1/lookup',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: 'Back, Baby', raw_message: 'Back, Baby' }),
        })
      );
    });

    it('wraps the call in a Sentry span and projects cache_stats onto it', async () => {
      const cache_stats = { memory_hits: 0, pg_hits: 2, pg_misses: 1, api_calls: 1 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            search_type: 'none',
            song_not_found: false,
            found_on_compilation: false,
            cache_stats,
          }),
      } as unknown as globalThis.Response);

      await lookupBySong('Back, Baby');

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockStartSpan.mock.calls[0][0]).toEqual({ name: 'lml.lookup', op: 'http.client' });
      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        'lml.cache.memory_hits': 0,
        'lml.cache.pg_hits': 2,
        'lml.cache.pg_misses': 1,
        'lml.cache.api_calls': 1,
      });
    });

    it('throws LmlClientError on non-2xx response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
      } as unknown as globalThis.Response);

      await expect(lookupBySong('Back, Baby')).rejects.toThrow(LmlClientError);
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

  describe('LML_API_KEY bearer header', () => {
    function lastCallHeaders(): Record<string, string> {
      const init = mockFetch.mock.calls.at(-1)?.[1];
      return (init?.headers ?? {}) as Record<string, string>;
    }

    it('includes Authorization: Bearer <key> when LML_API_KEY is set (POST)', async () => {
      process.env.LML_API_KEY = 'test-secret';
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ on_streaming: false, sources: {} }),
      } as unknown as globalThis.Response);

      await checkStreamingAvailability('Stereolab', 'Aluminum Tunes');

      expect(lastCallHeaders()).toMatchObject({
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/json',
      });
    });

    it('includes Authorization: Bearer <key> when LML_API_KEY is set (GET)', async () => {
      process.env.LML_API_KEY = 'test-secret';
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ artist_id: 1, name: 'Stereolab' }),
      } as unknown as globalThis.Response);

      await getArtistDetails(1);

      expect(lastCallHeaders()).toMatchObject({ Authorization: 'Bearer test-secret' });
    });

    it('does not include Authorization header when LML_API_KEY is unset', async () => {
      delete process.env.LML_API_KEY;
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ artist_id: 1, name: 'Stereolab' }),
      } as unknown as globalThis.Response);

      await getArtistDetails(1);

      expect(lastCallHeaders()).not.toHaveProperty('Authorization');
    });

    it('does not include Authorization header when LML_API_KEY is empty string', async () => {
      process.env.LML_API_KEY = '';
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ on_streaming: false, sources: {} }),
      } as unknown as globalThis.Response);

      await checkStreamingAvailability('a', 'b');

      expect(lastCallHeaders()).not.toHaveProperty('Authorization');
    });

    it('preserves caller-provided headers alongside the bearer header', async () => {
      process.env.LML_API_KEY = 'test-secret';
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ on_streaming: false, sources: {} }),
      } as unknown as globalThis.Response);

      await checkStreamingAvailability('a', 'b');

      const headers = lastCallHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toBe('Bearer test-secret');
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
