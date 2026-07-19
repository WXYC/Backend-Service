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
    // Verdicts are keyed by stringified id; a well-formed {artist_id, weight}
    // survives sanitization unchanged, and an empty list is preserved as [].
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

  it('narrows each neighbor to exactly {artist_id, weight}, dropping extra fields (leak barrier)', async () => {
    // A future endpoint field must not be persisted + re-emitted on
    // Concert.similar_artists (would violate the api.yaml SimilarArtist contract).
    fetchMock.mockResolvedValue(
      okJson({ results: { '4210': [{ artist_id: 5121, weight: 4.83, name: 'leak', heat: 0.9 }] } })
    );
    const res = await fetchNeighborsBatch([4210], 20);
    expect(res.results['4210']).toEqual([{ artist_id: 5121, weight: 4.83 }]);
    expect(res.results['4210'][0]).not.toHaveProperty('name');
  });

  it('drops malformed neighbor elements (non-numeric id/weight) rather than store garbage', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        results: {
          '4210': [
            { artist_id: 5121, weight: 4.83 },
            { artist_id: 'x', weight: 1 }, // bad id
            { artist_id: 9 }, // missing weight
            null,
          ],
        },
      })
    );
    const res = await fetchNeighborsBatch([4210], 20);
    expect(res.results['4210']).toEqual([{ artist_id: 5121, weight: 4.83 }]);
  });

  it('omits a non-array verdict value so the orchestrator routes that id as malformed', async () => {
    fetchMock.mockResolvedValue(okJson({ results: { '1': [{ artist_id: 2, weight: 1 }], '3': 'oops' } }));
    const res = await fetchNeighborsBatch([1, 3], 20);
    expect(res.results['1']).toEqual([{ artist_id: 2, weight: 1 }]);
    expect(res.results).not.toHaveProperty('3'); // dropped → absent → malformed downstream
  });

  // BS#1702 / semantic-index#369 — the additive `source_plays` map.
  it('parses source_plays keyed by the stringified input id', async () => {
    fetchMock.mockResolvedValue(
      okJson({ results: { '4210': [], '887': [] }, source_plays: { '4210': 312, '887': 58 } })
    );
    const res = await fetchNeighborsBatch([4210, 887], 20);
    expect(res.source_plays).toEqual({ '4210': 312, '887': 58 });
  });

  it('defaults source_plays to {} when the field is absent (un-deployed semantic-index)', async () => {
    fetchMock.mockResolvedValue(okJson({ results: { '1': [{ artist_id: 2, weight: 1 }] } }));
    const res = await fetchNeighborsBatch([1], 20);
    expect(res.source_plays).toEqual({});
  });

  it('defaults source_plays to {} when the field is not an object', async () => {
    fetchMock.mockResolvedValue(okJson({ results: { '1': [] }, source_plays: [312] }));
    const res = await fetchNeighborsBatch([1], 20);
    expect(res.source_plays).toEqual({});
  });

  it('drops non-integer, negative, and non-number play counts (validate, do not trust the wire)', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        results: { '1': [], '2': [], '3': [], '4': [], '5': [] },
        source_plays: { '1': 312, '2': 4.5, '3': -7, '4': 'x', '5': 0 },
      })
    );
    const res = await fetchNeighborsBatch([1, 2, 3, 4, 5], 20);
    // Only the non-negative integers survive (0 is valid); the fractional,
    // negative, and non-number values are dropped.
    expect(res.source_plays).toEqual({ '1': 312, '5': 0 });
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
