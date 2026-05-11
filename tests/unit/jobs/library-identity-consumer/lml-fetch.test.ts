/**
 * Unit tests for jobs/library-identity-consumer/lml-fetch.ts.
 *
 * Covers the four non-trivial behaviors:
 *   1. URL construction: trailing `/api/v1` is stripped from
 *      `LIBRARY_METADATA_URL`, and the canonical endpoint suffix
 *      (`/api/v1/identity/bulk-resolve-libraries`) is appended.
 *   2. Conditional `Authorization: Bearer …` header: sent only when
 *      `LML_API_KEY` is set (LML enforces auth in prod).
 *   3. Sentry span wrapping (`lml.bulk_resolve_libraries`, op=http.client)
 *      with `cache_stats` projection onto the span as `lml.cache.*`.
 *   4. Non-2xx and timeout error paths translate to a thrown Error so the
 *      orchestrator can count the batch as `lml_error`.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

const mockSpanSetAttributes = jest.fn();
const mockSpanSetAttribute = jest.fn();
type SpanLike = {
  setAttributes: typeof mockSpanSetAttributes;
  setAttribute: typeof mockSpanSetAttribute;
};
const mockStartSpan = jest.fn(
  async (_opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    await callback({ setAttributes: mockSpanSetAttributes, setAttribute: mockSpanSetAttribute })
);
jest.mock('@sentry/node', () => ({
  startSpan: (opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    mockStartSpan(opts, callback),
}));

import { bulkResolveLibraries } from '../../../../jobs/library-identity-consumer/lml-fetch';

describe('jobs/library-identity-consumer/lml-fetch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const okResponse = (body: unknown): globalThis.Response =>
    ({
      ok: true,
      json: () => Promise.resolve(body),
    }) as unknown as globalThis.Response;

  describe('URL construction', () => {
    it('appends /api/v1/identity/bulk-resolve-libraries to a plain base URL', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://lml.test:8000/api/v1/identity/bulk-resolve-libraries');
    });

    it('strips a trailing /api/v1 from the base URL (idempotent with the legacy convention)', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/api/v1';
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://lml.test:8000/api/v1/identity/bulk-resolve-libraries');
    });

    it('strips a trailing slash before appending the suffix (no double slash)', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/';
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://lml.test:8000/api/v1/identity/bulk-resolve-libraries');
    });

    it('throws when LIBRARY_METADATA_URL is unset', async () => {
      delete process.env.LIBRARY_METADATA_URL;
      await expect(bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }])).rejects.toThrow(
        /LIBRARY_METADATA_URL/
      );
    });
  });

  describe('Authorization header', () => {
    it('omits Authorization when LML_API_KEY is unset', async () => {
      delete process.env.LML_API_KEY;
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      const init = mockFetch.mock.calls[0][1];
      const headers = init?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Authorization');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends Authorization: Bearer <LML_API_KEY> when set', async () => {
      process.env.LML_API_KEY = 'secret-token';
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      const init = mockFetch.mock.calls[0][1];
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-token');
    });
  });

  describe('Request body shape', () => {
    it('POSTs `{ inputs }` with the verbatim batch payload', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      const inputs = [
        { library_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' },
        { library_id: 2, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
      ];
      await bulkResolveLibraries(inputs);
      const init = mockFetch.mock.calls[0][1];
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string) as { inputs: unknown };
      expect(body).toEqual({ inputs });
    });
  });

  describe('Sentry instrumentation', () => {
    it('wraps the call in a Sentry span (name=lml.bulk_resolve_libraries, op=http.client)', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockStartSpan.mock.calls[0][0]).toEqual({
        name: 'lml.bulk_resolve_libraries',
        op: 'http.client',
      });
    });

    it('sets the batch size as a span attribute', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([
        { library_id: 1, artist_name: 'A', album_title: 'a' },
        { library_id: 2, artist_name: 'B', album_title: 'b' },
        { library_id: 3, artist_name: 'C', album_title: 'c' },
      ]);
      expect(mockSpanSetAttribute).toHaveBeenCalledWith('lml.batch_size', 3);
    });

    it('projects numeric cache_stats fields onto the span as lml.cache.<key>', async () => {
      const cache_stats = {
        memory_hits: 1,
        pg_hits: 4,
        api_calls: 3,
      };
      mockFetch.mockResolvedValue(okResponse({ results: [], cache_stats }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        'lml.cache.memory_hits': 1,
        'lml.cache.pg_hits': 4,
        'lml.cache.api_calls': 3,
      });
    });

    it('does not project cache_stats when it is an array (defensive narrowing)', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [], cache_stats: [1, 2, 3] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      expect(mockSpanSetAttributes).not.toHaveBeenCalled();
    });

    it('resolves successfully even when span.setAttributes throws (observability never breaks the contract)', async () => {
      const body = { results: [], cache_stats: { memory_hits: 1 } };
      mockFetch.mockResolvedValue(okResponse(body));
      mockSpanSetAttributes.mockImplementation(() => {
        throw new Error('sentry boom');
      });
      const result = await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }]);
      expect(result).toEqual(body);
    });
  });

  describe('Error paths', () => {
    it('throws on non-2xx responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      } as unknown as globalThis.Response);
      await expect(bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }])).rejects.toThrow(
        /500 Internal Server Error/
      );
    });

    it('translates an AbortError into a clear timeout message', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);
      await expect(bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }])).rejects.toThrow(
        /timed out/
      );
    });

    it('rethrows non-abort network errors verbatim', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a' }])).rejects.toThrow(
        /ECONNREFUSED/
      );
    });
  });
});
