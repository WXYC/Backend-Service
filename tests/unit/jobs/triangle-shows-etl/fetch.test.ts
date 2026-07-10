/**
 * Unit tests for the triangle-shows HTTP client's retry policy: one
 * bounded retry on TRANSIENT failures only (network errors, timeouts,
 * 5xx — the cold-starting-host soft edge), immediate failure on
 * deterministic 4xx (replaying a 404/422 cannot succeed), and error
 * messages carrying a slice of the response body so FastAPI's 422
 * `detail` is self-describing. `globalThis.fetch` is stubbed; the retry
 * delay is injected as 0 so no test sleeps.
 */
import { getJsonWithRetry, resolveBaseUrl } from '../../../../jobs/triangle-shows-etl/fetch';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const errorResponse = (status: number, statusText: string, body: string): Response =>
  new Response(body, { status, statusText });

describe('getJsonWithRetry', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns parsed JSON on first success without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(getJsonWithRetry('https://ts.example/api/v1/health', 0)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on a 5xx and succeeds (the cold-start soft edge)', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, 'Service Unavailable', ''))
      .mockResolvedValueOnce(jsonResponse([1, 2]));
    await expect(getJsonWithRetry('https://ts.example/api/v1/venues', 0)).resolves.toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a network error and succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED')).mockResolvedValueOnce(jsonResponse([]));
    await expect(getJsonWithRetry('https://ts.example/api/v1/events', 0)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a deterministic 4xx and surfaces the response body', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(422, 'Unprocessable Entity', '{"detail":[{"loc":["query","start"],"msg":"invalid date"}]}')
    );
    await expect(getJsonWithRetry('https://ts.example/api/v1/events?start=bogus', 0)).rejects.toThrow(
      /422[\s\S]*invalid date/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports both attempts when the retry also fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('fetch failed: ETIMEDOUT'))
      .mockResolvedValueOnce(errorResponse(500, 'Internal Server Error', 'boom'));
    await expect(getJsonWithRetry('https://ts.example/api/v1/venues', 0)).rejects.toThrow(
      /500[\s\S]*first attempt[\s\S]*ETIMEDOUT/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolveBaseUrl', () => {
  it('throws when unset and strips trailing slashes', () => {
    expect(() => resolveBaseUrl(undefined)).toThrow(/TRIANGLE_SHOWS_URL/);
    expect(resolveBaseUrl('https://ts.example//')).toBe('https://ts.example');
    expect(resolveBaseUrl('https://ts.example')).toBe('https://ts.example');
  });
});
