/**
 * BS#3508: LML's response `cache_stats` is reported as `logCounter` lines (one per
 * numeric stat per response), replacing the `lml.cache.*` span attributes that
 * BS#3403 removed. The album-metadata-reask canary computes Discogs calls per album
 * from `lml.cache.api_calls` / `lml.lookup.items`. The client reports through an injected
 * sink (`setLmlCounterSink`), so it carries no dependency on `@wxyc/observability`;
 * with no sink configured it is a no-op.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import { lookupMetadata, bulkLookupMetadata, setLmlCounterSink, type LmlCounterSink } from '@wxyc/lml-client';

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

const lookupBody = { results: [], search_type: 'none', song_not_found: false, found_on_compilation: false };
const bulkBody = { results: [{ index: 0, status: 'no_match', lookup: lookupBody }] };
const bulkItem = { artist: 'Juana Molina', album: 'DOGA', raw_message: 'Juana Molina - DOGA' };

type Path = 'lookup' | 'bulk';

const run = async (path: Path, cacheStats: unknown): Promise<void> => {
  const withStats = cacheStats === undefined ? {} : { cache_stats: cacheStats };
  if (path === 'lookup') {
    mockFetch.mockResolvedValueOnce(okJson({ ...lookupBody, ...withStats }));
    await lookupMetadata('Juana Molina', 'DOGA', undefined, { caller: 'album-metadata-reask' });
  } else {
    mockFetch.mockResolvedValueOnce(okJson({ ...bulkBody, ...withStats }));
    await bulkLookupMetadata([bulkItem], { caller: 'album-metadata-reask' });
  }
};

describe('BS#3508 cache_stats counters', () => {
  const originalEnv = process.env;
  let sink: jest.Mock<LmlCounterSink>;

  const metrics = (): Record<string, unknown>[] =>
    sink.mock.calls.map(([metric, value, fields]) => ({ metric, value, ...fields }));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
    sink = jest.fn<LmlCounterSink>();
    setLmlCounterSink(sink);
  });

  afterEach(() => {
    setLmlCounterSink(undefined);
    process.env = originalEnv;
  });

  it.each<[Path]>([['lookup'], ['bulk']])(
    '%s: with no sink configured, emits nothing and does not throw',
    async (path) => {
      setLmlCounterSink(undefined);
      await expect(run(path, { api_calls: 3 })).resolves.toBeUndefined();
      expect(sink).not.toHaveBeenCalled();
    }
  );

  it.each<[Path]>([['lookup'], ['bulk']])(
    '%s: emits one counter per numeric stat, tagged with caller and endpoint',
    async (path) => {
      await run(path, { api_calls: 3, pg_hits: 5, label: 'x', bad: Number.NaN });

      const lines = metrics().filter((l) => (l.metric as string).startsWith('lml.cache.'));
      expect(lines).toEqual([
        { metric: 'lml.cache.api_calls', value: 3, caller: 'album-metadata-reask', endpoint: path },
        { metric: 'lml.cache.pg_hits', value: 5, caller: 'album-metadata-reask', endpoint: path },
      ]);
    }
  );

  it('bulk: also emits the batch size as lml.lookup.items', async () => {
    await run('bulk', { api_calls: 1 });
    expect(metrics()).toContainEqual({
      metric: 'lml.lookup.items',
      value: 1,
      caller: 'album-metadata-reask',
      endpoint: 'bulk',
    });
  });

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['a string', 'api_calls=3'],
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['all non-numeric', { api_calls: '3', pg_hits: null }],
  ])('emits nothing and does not throw when cache_stats is %s', async (_label, stats) => {
    for (const path of ['lookup', 'bulk'] as const) {
      await expect(run(path, stats)).resolves.toBeUndefined();
    }
    expect(metrics()).toEqual([]);
  });
});
