/**
 * Unit tests for jobs/library-identity-consumer/lml-fetch.ts.
 *
 * Covers the three non-trivial behaviors:
 *   1. URL construction: trailing `/api/v1` is stripped from
 *      `LIBRARY_METADATA_URL`, and the canonical endpoint suffix
 *      (`/api/v1/identity/bulk-resolve-libraries`) is appended.
 *   2. Conditional `Authorization: Bearer …` header: sent only when
 *      `LML_API_KEY` is set (LML enforces auth in prod).
 *   3. Non-2xx and timeout error paths translate to a thrown Error so the
 *      orchestrator can count the batch as `lml_error`.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import { bulkResolveLibraries, LmlFetchError } from '../../../../jobs/library-identity-consumer/lml-fetch';

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
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://lml.test:8000/api/v1/identity/bulk-resolve-libraries');
    });

    it('strips a trailing /api/v1 from the base URL (idempotent with the legacy convention)', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/api/v1';
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://lml.test:8000/api/v1/identity/bulk-resolve-libraries');
    });

    it('strips a trailing slash before appending the suffix (no double slash)', async () => {
      process.env.LIBRARY_METADATA_URL = 'http://lml.test:8000/';
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://lml.test:8000/api/v1/identity/bulk-resolve-libraries');
    });

    it('throws when LIBRARY_METADATA_URL is unset', async () => {
      delete process.env.LIBRARY_METADATA_URL;
      await expect(
        bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }])
      ).rejects.toThrow(/LIBRARY_METADATA_URL/);
    });
  });

  describe('Authorization header', () => {
    it('omits Authorization when LML_API_KEY is unset', async () => {
      delete process.env.LML_API_KEY;
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]);
      const init = mockFetch.mock.calls[0][1];
      const headers = init?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Authorization');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends Authorization: Bearer <LML_API_KEY> when set', async () => {
      process.env.LML_API_KEY = 'secret-token';
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]);
      const init = mockFetch.mock.calls[0][1];
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-token');
    });
  });

  describe('Request body shape', () => {
    it('POSTs `{ inputs, include_tracks: true }` with the verbatim batch payload', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      const inputs = [
        { library_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', legacy_release_id: 1000001 },
        {
          library_id: 2,
          artist_name: 'Jessica Pratt',
          album_title: 'On Your Own Love Again',
          legacy_release_id: 1000002,
        },
      ];
      await bulkResolveLibraries(inputs);
      const init = mockFetch.mock.calls[0][1];
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string) as { inputs: unknown; include_tracks: boolean };
      expect(body).toEqual({ inputs, include_tracks: true });
    });

    it('BS#1991: always sends include_tracks: true, regardless of cohort (both va and non_va drains request tracks)', async () => {
      mockFetch.mockResolvedValue(okResponse({ results: [] }));
      await bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]);
      const init = mockFetch.mock.calls[0][1];
      const body = JSON.parse(init?.body as string) as { include_tracks: boolean };
      expect(body.include_tracks).toBe(true);
    });
  });

  describe('Response', () => {
    it('returns the parsed body untouched', async () => {
      const body = { results: [], cache_stats: { memory_hits: 1 } };
      mockFetch.mockResolvedValue(okResponse(body));
      const result = await bulkResolveLibraries([
        { library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 },
      ]);
      expect(result).toEqual(body);
    });
  });

  describe('Error paths', () => {
    const expectLmlError = async (
      promise: Promise<unknown>,
      expected: { status: number | null; retryable: boolean; messageMatch: RegExp }
    ): Promise<void> => {
      try {
        await promise;
        throw new Error('expected LmlFetchError to be thrown');
      } catch (caught) {
        expect(caught).toBeInstanceOf(LmlFetchError);
        const err = caught as LmlFetchError;
        expect(err.status).toBe(expected.status);
        expect(err.retryable).toBe(expected.retryable);
        expect(err.message).toMatch(expected.messageMatch);
      }
    };

    it('throws LmlFetchError(status=500, retryable=true) on 5xx', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      } as unknown as globalThis.Response);
      await expectLmlError(
        bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]),
        {
          status: 500,
          retryable: true,
          messageMatch: /500 Internal Server Error/,
        }
      );
    });

    it('throws LmlFetchError(status=400, retryable=false) on 4xx (non-retryable)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({}),
      } as unknown as globalThis.Response);
      await expectLmlError(
        bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]),
        {
          status: 400,
          retryable: false,
          messageMatch: /400 Bad Request/,
        }
      );
    });

    it('translates AbortError into LmlFetchError(status=null, retryable=true) with a timeout message', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);
      await expectLmlError(
        bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]),
        {
          status: null,
          retryable: true,
          messageMatch: /timed out/,
        }
      );
    });

    it('wraps non-abort network errors as LmlFetchError(status=null, retryable=true)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expectLmlError(
        bulkResolveLibraries([{ library_id: 1, artist_name: 'A', album_title: 'a', legacy_release_id: 1 }]),
        {
          status: null,
          retryable: true,
          messageMatch: /network error.*ECONNREFUSED/,
        }
      );
    });
  });
});
