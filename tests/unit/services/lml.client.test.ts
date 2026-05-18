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
  Semaphore,
  TokenBucket,
  getLmlQueueDepth,
  _resetLmlClientLimitersForTest,
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

    it('does not project lml.cache.* attributes when LML response omits cache_stats', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      // BS#906 adds `lml.queue_depth` to setAttributes for every /lookup;
      // assertion narrows to "no lml.cache.* keys" rather than "never called".
      const cacheCalls = mockSpanSetAttributes.mock.calls.filter((args) =>
        Object.keys((args[0] ?? {}) as Record<string, unknown>).some((k) => k.startsWith('lml.cache.'))
      );
      expect(cacheCalls).toHaveLength(0);
    });

    it('does not project lml.cache.* attributes when cache_stats is an array (defensive narrowing)', async () => {
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

      const cacheCalls = mockSpanSetAttributes.mock.calls.filter((args) =>
        Object.keys((args[0] ?? {}) as Record<string, unknown>).some((k) => k.startsWith('lml.cache.'))
      );
      expect(cacheCalls).toHaveLength(0);
    });

    // E1 / BS#901: LML#354 added `pg_negative_hits` and `pg_negative_misses`
    // to cache_stats. The existing projection iterates every numeric field,
    // so these keys flow through with zero code change. This test pins that
    // contract — if a future refactor narrows the projection (e.g., a hard-
    // coded whitelist of known keys), the new keys would silently disappear
    // from Sentry traces and we'd lose visibility into the negative-cache
    // hit rate post-deploy. Companion to WXYC/library-metadata-lookup#341.
    it('projects pg_negative_hits and pg_negative_misses onto the span (LML#341/A4 cache_stats)', async () => {
      const cache_stats = {
        memory_hits: 0,
        pg_hits: 0,
        pg_misses: 0,
        pg_negative_hits: 5,
        pg_negative_misses: 3,
        api_calls: 0,
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

      // Both new keys must reach the span as lml.cache.<key>.
      const projected = mockSpanSetAttributes.mock.calls
        .map((args) => (args[0] ?? {}) as Record<string, unknown>)
        .find((attrs) => 'lml.cache.pg_negative_hits' in attrs);
      expect(projected).toBeDefined();
      expect(projected).toEqual(
        expect.objectContaining({
          'lml.cache.pg_negative_hits': 5,
          'lml.cache.pg_negative_misses': 3,
        })
      );
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

describe('Semaphore (BS#906)', () => {
  it('admits up to N permits immediately; the (N+1)th call queues', async () => {
    const sem = new Semaphore(2);

    // Two immediate admits.
    await sem.acquire();
    await sem.acquire();
    expect(sem.availablePermits).toBe(0);
    expect(sem.queueDepth).toBe(0);

    // The third call queues — does NOT resolve until a permit is released.
    let thirdAcquired = false;
    const thirdAcquirePromise = sem.acquire().then(() => {
      thirdAcquired = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdAcquired).toBe(false);
    expect(sem.queueDepth).toBe(1);

    sem.release();
    await thirdAcquirePromise;
    expect(thirdAcquired).toBe(true);
    expect(sem.queueDepth).toBe(0);
  });

  it('release before any waiter restores a permit (no negative permits)', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    sem.release();
    sem.release(); // No-op once permits are full — must not exceed capacity.
    expect(sem.availablePermits).toBe(2);
  });

  it('FIFO: queued waiters drain in the order they were enqueued', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const first = sem.acquire().then(() => order.push(1));
    const second = sem.acquire().then(() => order.push(2));
    const third = sem.acquire().then(() => order.push(3));

    expect(sem.queueDepth).toBe(3);

    sem.release(); // first runs
    await first;
    expect(order).toEqual([1]);
    sem.release(); // second runs
    await second;
    sem.release(); // third runs
    await third;
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('TokenBucket (BS#906)', () => {
  it('admits up to capacity immediately, then waits for refill', async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerMinute: 6_000 }); // 100/sec → 1 per 10ms

    // Three immediate consumes succeed without blocking.
    await bucket.consume(1);
    await bucket.consume(1);
    await bucket.consume(1);

    // The 4th must wait for at least one refill (~10ms).
    const start = Date.now();
    await bucket.consume(1);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it('refill caps at capacity (no unbounded accumulation)', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerMinute: 60_000 }); // 1 per ms
    await bucket.consume(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // After 50 ms of refill, we'd have 50 tokens uncapped — must cap at 2.
    expect(bucket.availableTokens).toBeLessThanOrEqual(2);
  });

  it('multi-consumer: concurrent consume() calls do not over-subtract from a shared refill', async () => {
    // Regression: without the slow-path loop, N consumers that all
    // sleep on the same `waitMs` from an empty bucket would each subtract
    // `count` on wake — overshooting the rate by N×. With the loop,
    // only the consumer that finds enough tokens after refill proceeds;
    // the others sleep again. Net effect under contention is that the
    // bucket never goes negative and total throughput stays at the
    // configured rate.
    const bucket = new TokenBucket({ capacity: 1, refillPerMinute: 6_000 }); // 100/sec
    // Drain the initial capacity.
    await bucket.consume(1);

    // Now three consumers race for tokens; the bucket refills 1 every
    // 10 ms. Without the fix, all three would resolve after the first
    // shared sleep, leaving the bucket at -2. With the fix, they
    // serialize at ~10 ms intervals.
    const start = Date.now();
    await Promise.all([bucket.consume(1), bucket.consume(1), bucket.consume(1)]);
    const elapsed = Date.now() - start;

    // 3 tokens × 10 ms each = ~30 ms minimum. Allow generous overhead
    // for jest's timer scheduling on slower CI machines (typical drift
    // 5-15 ms per setTimeout under load).
    expect(elapsed).toBeGreaterThanOrEqual(20);
    // And the bucket must not be negative — invariant: tokens >= 0.
    expect(bucket.availableTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('lml.client rate-aware /lookup wrapper (BS#906)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      LIBRARY_METADATA_URL: 'http://lml.test:8000',
      LML_CLIENT_MAX_CONCURRENT: '3',
      LML_CLIENT_RATE_PER_MIN: '60000', // 1000/sec — effectively no rate cap in tests
    };
    _resetLmlClientLimitersForTest();
  });

  afterAll(() => {
    process.env = originalEnv;
    _resetLmlClientLimitersForTest();
  });

  it('caps concurrent /lookup in-flight calls at LML_CLIENT_MAX_CONCURRENT', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveBatch: (() => void) | undefined;
    const batchReady = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });

    mockFetch.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await batchReady;
      inFlight -= 1;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            search_type: 'none',
            song_not_found: false,
            found_on_compilation: false,
          }),
      } as unknown as globalThis.Response;
    });

    // Fire 5 concurrent lookups when MAX_CONCURRENT=3.
    const calls = [
      lookupMetadata('Stereolab', 'Dots and Loops'),
      lookupMetadata('Cat Power', 'Moon Pix'),
      lookupMetadata('Juana Molina', 'DOGA'),
      lookupMetadata('Jessica Pratt', 'On Your Own Love Again'),
      lookupMetadata('Chuquimamani-Condori', 'Edits'),
    ];

    // Poll until the first batch lands at fetch. Polling beats a magic
    // setImmediate-flush count because the chain depth between
    // `lookupMetadata` and `mockFetch` (semaphore acquire → token consume
    // → Sentry.startSpan → lmlFetch → fetch) can change without warning.
    // Cap at 200 ms so a real regression that never reaches fetch fails
    // the test loudly rather than hanging.
    const deadline = Date.now() + 200;
    while (inFlight < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // At most 3 should be in flight — the rest are queued in the semaphore.
    expect(maxInFlight).toBe(3);
    expect(getLmlQueueDepth()).toBeGreaterThan(0);

    // Release the batch and let everyone finish.
    if (resolveBatch) resolveBatch();
    await Promise.all(calls);

    // After completion, all permits restored, queue empty.
    expect(getLmlQueueDepth()).toBe(0);
  });
});
