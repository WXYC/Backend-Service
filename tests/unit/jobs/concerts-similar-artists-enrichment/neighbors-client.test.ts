/**
 * Unit tests for jobs/concerts-similar-artists-enrichment neighbors-client.ts
 * (BS#1626). Mocks the global `fetch` to pin the semantic-index#354 request
 * contract and the error/shape handling, without touching the network.
 *
 * `neighbors-client.ts` imports only a TYPE from `@wxyc/database` (erased at
 * compile), so this suite needs no DB mock.
 */
import { jest } from '@jest/globals';

import {
  NeighborsClientError,
  SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP,
  fetchGraphHealth,
  fetchNeighborsBatch,
} from '../../../../jobs/concerts-similar-artists-enrichment/neighbors-client';

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

const errStatus = (status: number): Response =>
  ({ ok: false, status, json: () => Promise.resolve({}) }) as unknown as Response;

describe('fetchNeighborsBatch (semantic-index#354)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.SEMANTIC_INDEX_URL;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('POSTs {library_artist_ids, limit} with heat omitted, to the batch route', async () => {
    fetchMock.mockResolvedValue(okJson({ results: { '4210': [{ artist_id: 5121, weight: 4.83 }], '887': [] } }));

    const res = await fetchNeighborsBatch([4210, 887], 20);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://explore.wxyc.org/graph/library-artists/neighbors/batch');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ library_artist_ids: [4210, 887], limit: 20 });
    expect(body).not.toHaveProperty('heat'); // server default 0.5 is the prod blend
    // Response passes through verbatim, keyed by stringified id.
    expect(res.results['4210']).toEqual([{ artist_id: 5121, weight: 4.83 }]);
    expect(res.results['887']).toEqual([]);
  });

  it('honours SEMANTIC_INDEX_URL and strips a trailing slash', async () => {
    process.env.SEMANTIC_INDEX_URL = 'http://localhost:9999/';
    fetchMock.mockResolvedValue(okJson({ results: { '1': [] } }));
    await fetchNeighborsBatch([1], 20);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://localhost:9999/graph/library-artists/neighbors/batch'
    );
  });

  it('throws on empty input without calling fetch', async () => {
    await expect(fetchNeighborsBatch([], 20)).rejects.toBeInstanceOf(NeighborsClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on an over-cap batch without calling fetch', async () => {
    const ids = Array.from({ length: SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP + 1 }, (_, i) => i + 1);
    await expect(fetchNeighborsBatch(ids, 20)).rejects.toThrow(/exceeded the cap/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws NeighborsClientError carrying the HTTP status on a non-2xx (e.g. 422)', async () => {
    fetchMock.mockResolvedValue(errStatus(422));
    await expect(fetchNeighborsBatch([1, 2], 20)).rejects.toMatchObject({ status: 422 });
  });

  it('throws when `results` is not an object (shape guard)', async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    await expect(fetchNeighborsBatch([1], 20)).rejects.toThrow(/`results` is not an object/);
  });
});

describe('fetchGraphHealth', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.SEMANTIC_INDEX_URL;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns the numeric mapped_artist_count from /health', async () => {
    fetchMock.mockResolvedValue(okJson({ mapped_artist_count: 22000 }));
    await expect(fetchGraphHealth()).resolves.toEqual({ mapped_artist_count: 22000 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://explore.wxyc.org/health');
  });

  it('resolves to null (never throws) on a failed probe', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchGraphHealth()).resolves.toEqual({ mapped_artist_count: null });
  });

  it('resolves to null when the body lacks a numeric mapped_artist_count', async () => {
    fetchMock.mockResolvedValue(okJson({ status: 'ok' }));
    await expect(fetchGraphHealth()).resolves.toEqual({ mapped_artist_count: null });
  });
});
